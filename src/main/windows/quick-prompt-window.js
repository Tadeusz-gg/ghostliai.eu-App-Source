const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let quickPromptWin = null;
let mainWindowRef = null;
let ipcRegistered = false;

function toggleQuickPrompt(mainWindow) {
  mainWindowRef = mainWindow;

  if (!ipcRegistered) {
    ipcMain.on('quick-prompt-submit', (event, promptText) => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.show();
        if (mainWindowRef.isMinimized()) mainWindowRef.restore();
        mainWindowRef.focus();
        mainWindowRef.webContents.send('execute-quick-prompt', promptText);
      }
      if (quickPromptWin && !quickPromptWin.isDestroyed()) {
        quickPromptWin.hide();
      }
    });

    ipcMain.on('quick-prompt-close', () => {
      if (quickPromptWin && !quickPromptWin.isDestroyed()) {
        quickPromptWin.hide();
      }
    });
    
    ipcRegistered = true;
  }

  if (quickPromptWin) {
    if (quickPromptWin.isVisible()) {
      quickPromptWin.hide();
    } else {
      quickPromptWin.show();
      quickPromptWin.focus();
    }
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  quickPromptWin = new BrowserWindow({
    width: 720,
    height: 400, // Zapas na menu wyboru modelu
    x: Math.round(width / 2 - 360),
    y: Math.round(height / 2 - 220),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../../preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Przekazujemy aktualny model w URL
  const currentModel = mainWindowRef ? 'g-basic' : 'g-basic'; // Uproszczone, docelowo pobierzemy ze stanu
  quickPromptWin.loadFile(path.join(__dirname, '../../quick-prompt.html'));

  quickPromptWin.once('ready-to-show', () => {
    quickPromptWin.show();
    quickPromptWin.focus();
  });

  quickPromptWin.on('blur', () => {
    quickPromptWin.hide();
  });
}

function hideQuickPrompt() {
  if (quickPromptWin && quickPromptWin.isVisible()) {
    quickPromptWin.hide();
  }
}

function destroyQuickPrompt() {
  if (quickPromptWin && !quickPromptWin.isDestroyed()) {
    quickPromptWin.destroy();
  }
}

module.exports = { toggleQuickPrompt, hideQuickPrompt, destroyQuickPrompt };
