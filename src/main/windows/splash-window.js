/**
 * Splash Window Factory
 *
 * Creates and manages the splash/loading screen displayed
 * while the application initializes and checks for updates.
 */
const { BrowserWindow } = require('electron');
const path = require('node:path');

/**
 * Creates a frameless, always-on-top splash window.
 * @returns {{ window: BrowserWindow, startTime: number }}
 */
function createSplashWindow() {
    const startTime = Date.now();

    const window = new BrowserWindow({
        width: 400,
        height: 500,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'splash-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            enableRemoteModule: false,
            sandbox: false
        }
    });

    window.loadFile(path.join(__dirname, '..', '..', 'splash.html'));

    window.once('ready-to-show', () => {
        window.show();
    });

    return { window, startTime };
}

module.exports = { createSplashWindow };
