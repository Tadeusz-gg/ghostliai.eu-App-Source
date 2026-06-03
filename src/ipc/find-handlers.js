const { ipcMain } = require('electron');

/**
 * IPC Handlers — Find in Page
 *
 * Handles: find-in-page, stop-find-in-page
 *
 * @param {() => BrowserWindow} getMainWindow
 */
function registerFindIPC(getMainWindow) {
    ipcMain.on('find-in-page', (event, text, options) => {
        const win = getMainWindow();
        if (win) {
            win.webContents.findInPage(text, options);
        }
    });

    ipcMain.on('stop-find-in-page', (event, action) => {
        const win = getMainWindow();
        if (win) {
            win.webContents.stopFindInPage(action);
        }
    });
}

module.exports = { registerFindIPC };
