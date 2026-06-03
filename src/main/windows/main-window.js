/**
 * Main Window Factory
 *
 * Creates the primary application window with:
 * - Persisted window size preferences
 * - Security hardening (disabled devtools, zoom lock, key blocking)
 * - Splash-to-main transition logic
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('fs');

/** @type {{ small: {w:number,h:number}, large: {w:number,h:number}, extralarge: {w:number,h:number}, huge: {w:number,h:number} }} */
const WINDOW_SIZES = {
    small: { w: 1200, h: 670 },
    large: { w: 1350, h: 730 },   // default
    extralarge: { w: 1450, h: 800 },
    huge: { w: 1600, h: 900 }
};

const DEFAULT_SIZE = WINDOW_SIZES.large;
const MIN_SPLASH_DISPLAY_MS = 2500;

/* ------------------------------------------------------------------ */
/*  Settings persistence                                               */
/* ------------------------------------------------------------------ */

function getSettingsPath() {
    return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
    const userDataPath = getSettingsPath();
    const bundledPath = path.join(__dirname, '..', '..', 'settings.json');

    try {
        if (fs.existsSync(userDataPath)) {
            return JSON.parse(fs.readFileSync(userDataPath, 'utf8'));
        }

        // First run — migrate bundled settings to writable location
        if (fs.existsSync(bundledPath)) {
            const settings = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
            fs.writeFileSync(userDataPath, JSON.stringify(settings, null, 2));
            return settings;
        }
    } catch {
        console.log('[MainWindow] Using default settings');
    }

    return {};
}

function resolveWindowSize(settings) {
    if (settings.windowSize === 'custom' && settings.customWidth && settings.customHeight) {
        return { w: settings.customWidth, h: settings.customHeight };
    }
    const key = settings.windowSize;
    return WINDOW_SIZES[key] || DEFAULT_SIZE;
}

/* ------------------------------------------------------------------ */
/*  Security policies                                                  */
/* ------------------------------------------------------------------ */

/** Blocks dev-tools shortcuts, zoom changes, and other restricted keys. */
function applyInputRestrictions(webContents) {
    webContents.on('devtools-opened', () => webContents.closeDevTools());

    webContents.on('before-input-event', (event, input) => {
        const { key, control, shift, type } = input;

        // Block F11, F12
        if (key === 'F11' || key === 'F12') { event.preventDefault(); return; }

        // Block Ctrl+Shift combinations: zoom (+/-), DevTools (I/J), view-source (C)
        if (control && shift && ['+', '=', '-', 'I', 'J', 'C'].includes(key)) {
            event.preventDefault(); return;
        }

        // Block Ctrl+U (view source)
        if (control && key === 'U') { event.preventDefault(); return; }

        // Block Ctrl+scroll (zoom)
        if (control && type === 'mouseWheel') { event.preventDefault(); return; }

        // Allow Ctrl+0 (reset zoom) to pass through
    });

    webContents.setZoomFactor(1.0);
    webContents.setZoomLevel(0);
}

/* ------------------------------------------------------------------ */
/*  Window creation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Creates and returns the main application window.
 *
 * @param {object}  opts
 * @param {BrowserWindow|null} opts.splashWindow  — splash to close after transition
 * @param {number}  opts.splashStartTime          — timestamp when splash was shown
 * @param {(win: BrowserWindow) => void} opts.onReady — called when window is visible
 * @returns {BrowserWindow}
 */
function createMainWindow({ splashWindow, splashStartTime, onReady }) {
    const settings = loadSettings();
    const size = resolveWindowSize(settings);

    const mainWindow = new BrowserWindow({
        width: size.w,
        height: size.h,
        minWidth: 700,
        minHeight: 500,
        frame: false,
        resizable: true,
        maximizable: true,
        minimizable: true,
        fullscreenable: false,
        show: false,
        icon: path.join(__dirname, '..', '..', 'assets', 'newicon.ico'),
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            zoomFactor: 1.0,
            enableRemoteModule: false,
            devTools: false,
            webSecurity: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));
    applyInputRestrictions(mainWindow.webContents);

    mainWindow.webContents.on('found-in-page', (event, result) => {
        mainWindow.webContents.send('found-in-page', result);
    });

    // Save window size on manual resize
    mainWindow.on('resized', () => {
        try {
            const settingsPath = getSettingsPath();
            let currentSettings = {};
            if (fs.existsSync(settingsPath)) {
                currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            }

            const [w, h] = mainWindow.getSize();
            // Match against standard sizes
            const sizeKeyMatch = Object.keys(WINDOW_SIZES).find(k =>
                WINDOW_SIZES[k].w === w && WINDOW_SIZES[k].h === h
            );

            if (sizeKeyMatch) {
                currentSettings.windowSize = sizeKeyMatch;
                delete currentSettings.customWidth;
                delete currentSettings.customHeight;
            } else {
                currentSettings.windowSize = 'custom';
                currentSettings.customWidth = w;
                currentSettings.customHeight = h;
            }

            fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));
            mainWindow.webContents.send('window-resized-by-user', {
                size: sizeKeyMatch || 'custom',
                w,
                h
            });
        } catch (err) {
            console.error('[MainWindow] Error saving bounds on resize:', err);
        }
    });

    // Splash → Main window transition
    mainWindow.once('ready-to-show', () => {
        const elapsed = Date.now() - splashStartTime;
        const waitTime = Math.max(MIN_SPLASH_DISPLAY_MS, elapsed);

        if (splashWindow) {
            splashWindow.webContents.send('update-progress', {
                elapsed,
                minTime: MIN_SPLASH_DISPLAY_MS,
                remaining: Math.max(0, MIN_SPLASH_DISPLAY_MS - elapsed)
            });
        }

        setTimeout(() => {
            if (splashWindow) {
                splashWindow.webContents.send('close-splash');
            }
            mainWindow.show();
            if (onReady) onReady(mainWindow);
        }, waitTime);
    });

    return mainWindow;
}

module.exports = { createMainWindow, WINDOW_SIZES, getSettingsPath };
