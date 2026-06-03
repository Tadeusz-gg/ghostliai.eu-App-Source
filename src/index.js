/**
 * Ghostli main process
 *
 * This file is intentionally minimal. All logic is delegated to:
 *   - main/updater.js         → auto-update pipeline
 *   - main/windows/           → window factories (splash, main)
 *   - ipc/                    → IPC handler modules
 *   - database.js             → SQLite persistence layer
 */
const { app, BrowserWindow, globalShortcut } = require('electron');

const DatabaseManager = require('./database');
const { setupAutoUpdater, autoUpdater } = require('./main/updater');
const { createSplashWindow } = require('./main/windows/splash-window');
const { createMainWindow } = require('./main/windows/main-window');
const { registerAllIPC } = require('./ipc');

if (!app.isPackaged) {
  try {
    require('electron-reloader')(module, {
      watchRenderer: true,
      debug: false
    });
  } catch (error) {
    console.warn('[Dev] electron-reloader unavailable:', error);
  }
}

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

if (require('electron-squirrel-startup')) app.quit();

const db = new DatabaseManager();

let mainWindow = null;
let splashWindow = null;
let splashStartTime = 0;

// Wire up auto-updater → splash screen communication
setupAutoUpdater(() => splashWindow);

/* ------------------------------------------------------------------ */
/*  Application Ready                                                  */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  app.setName('Ghostli');
  if (process.platform === 'win32') {
    app.setAppUserModelId('Ghostli');
  }

  try {
    await db.initialize();
  } catch (err) {
    console.error('[App] Failed to initialize database:', err);
  }

 
  const splash = createSplashWindow();
  splashWindow = splash.window;
  splashStartTime = splash.startTime;

 
  const { toggleQuickPrompt, hideQuickPrompt } = require('./main/windows/quick-prompt-window');
  
  let appIsUnlocked = false;
  const { ipcMain } = require('electron');
  ipcMain.on('set-app-login-state', (event, state) => {
    appIsUnlocked = state;
    if (!appIsUnlocked && typeof hideQuickPrompt === 'function') {
      hideQuickPrompt();
    }
  });

  let currentShortcuts = { alwaysOnTop: true, quickPrompt: true };
  
  function applyGlobalShortcuts() {
    globalShortcut.unregisterAll();
    
    if (currentShortcuts.quickPrompt !== false) {
      globalShortcut.register('Alt+I', () => {
        if (appIsUnlocked) {
          if (mainWindow && mainWindow.isFocused()) return;
          toggleQuickPrompt(mainWindow);
        }
      });
    }

    if (currentShortcuts.alwaysOnTop !== false) {
      globalShortcut.register('CommandOrControl+Shift+O', () => {
        if (!mainWindow) return;
        const newState = !mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(newState);
        console.log(`[App] Always on Top: ${newState ? 'enabled' : 'disabled'}`);
        mainWindow.webContents.send('always-on-top-changed', newState);
      });
    }
  }

  applyGlobalShortcuts();

  ipcMain.on('update-shortcuts', (event, settings) => {
    currentShortcuts = settings;
    applyGlobalShortcuts();
  });

  app.on('browser-window-focus', (event, window) => {
    if (window === mainWindow && typeof hideQuickPrompt === 'function') {
      hideQuickPrompt();
    }
  });

  
  splashWindow.once('ready-to-show', () => {
    console.log('[App] Checking for updates…');
    autoUpdater.checkForUpdatesAndNotify();
  });

 
  registerAllIPC({ getMainWindow: () => mainWindow, db });


  setTimeout(() => {
    mainWindow = createMainWindow({
      splashWindow,
      splashStartTime,
      onReady: () => {
        splashWindow = null; 
      }
    });

    if (mainWindow) {
      mainWindow.on('closed', () => {
        const { destroyQuickPrompt } = require('./main/windows/quick-prompt-window');
        if (typeof destroyQuickPrompt === 'function') destroyQuickPrompt();
      });
    }
  }, 100);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const s = createSplashWindow();
      splashWindow = s.window;
      splashStartTime = s.startTime;

      setTimeout(() => {
        mainWindow = createMainWindow({
          splashWindow,
          splashStartTime,
          onReady: () => { splashWindow = null; }
        });

        if (mainWindow) {
          mainWindow.on('closed', () => {
            const { destroyQuickPrompt } = require('./main/windows/quick-prompt-window');
            if (typeof destroyQuickPrompt === 'function') destroyQuickPrompt();
          });
        }
      }, 100);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Cleanup                                                            */
/* ------------------------------------------------------------------ */

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  
  const { destroyQuickPrompt } = require('./main/windows/quick-prompt-window');
  if (typeof destroyQuickPrompt === 'function') destroyQuickPrompt();

  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
});
