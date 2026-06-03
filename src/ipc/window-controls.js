/**
 * IPC Handlers — Window Controls
 *
 * Handles: minimize, close, resize, reload, focus, always-on-top toggle.
 * These are renderer-initiated window management actions.
 */
const { ipcMain, app } = require('electron');
const fs = require('fs');
const { WINDOW_SIZES, getSettingsPath } = require('../main/windows/main-window');

/**
 * @param {() => BrowserWindow} getMainWindow
 */
function registerWindowControlsIPC(getMainWindow) {
    ipcMain.on('minimizewindow', () => {
        const win = getMainWindow();
        if (win) win.minimize();
    });

    ipcMain.on('closewindow', () => {
        const win = getMainWindow();
        if (win) win.close();
    });

    ipcMain.on('reload-app', () => {
        const win = getMainWindow();
        if (win) win.reload();
    });

    ipcMain.on('focus-app', () => {
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    });

    ipcMain.on('toggle-always-on-top', () => {
        const win = getMainWindow();
        if (!win) return;

        const newState = !win.isAlwaysOnTop();
        win.setAlwaysOnTop(newState);
        console.log(`[Window] Always on Top: ${newState ? 'enabled' : 'disabled'}`);
        win.webContents.send('always-on-top-changed', newState);
    });

    ipcMain.on('resize-window', (_event, size) => {
        const win = getMainWindow();
        if (!win) return;

        console.log(`[Window] Resizing to: ${size}`);

        // Persist the user's choice
        try {
            const settingsPath = getSettingsPath();
            let settings = {};
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            }
            settings.windowSize = size;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        } catch (error) {
            console.error('[Window] Error saving window size:', error);
        }

        // Apply the new dimensions
        const dimensions = WINDOW_SIZES[size];
        if (!dimensions) return;

        const { x, y } = win.getBounds();
        win.setBounds({ x, y, width: dimensions.w, height: dimensions.h });

        setTimeout(() => {
            win.webContents.send('window-resized', size);
        }, 200);
    });

    const { clipboard } = require('electron');
    ipcMain.on('copy-to-clipboard', (_event, text) => {
        clipboard.writeText(text);
    });
}

module.exports = { registerWindowControlsIPC };
