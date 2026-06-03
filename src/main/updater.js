/**
 * Auto-Updater Module
 *
 * Configures electron-updater for GitHub Releases and
 * relays download progress to the splash screen.
 */
const { autoUpdater } = require('electron-updater');

/**
 * Initializes the auto-updater event pipeline.
 *
 * @param {() => BrowserWindow|null} getSplashWindow
 *   Getter that returns the current splash window (or null if already closed).
 */
function setupAutoUpdater(getSplashWindow) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'stticzko',
        repo: 'ghostli-app'
    });

    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for update…');
        const splash = getSplashWindow();
        if (splash) splash.webContents.send('update-status', { status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[Updater] Update available: v${info.version}`);
        const splash = getSplashWindow();
        if (splash) splash.webContents.send('update-status', { status: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[Updater] No update available');
        const splash = getSplashWindow();
        if (splash) splash.webContents.send('update-status', { status: 'not-available' });
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Error:', err.message);
        const splash = getSplashWindow();
        if (splash) splash.webContents.send('update-status', { status: 'error', error: err.message });
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`[Updater] Download: ${progress.percent.toFixed(1)}%`);
        const splash = getSplashWindow();
        if (splash) {
            splash.webContents.send('update-progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                total: progress.total,
                transferred: progress.transferred
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[Updater] Downloaded: v${info.version} — installing in 2 s`);
        const splash = getSplashWindow();
        if (splash) splash.webContents.send('update-status', { status: 'downloaded', version: info.version });

        setTimeout(() => autoUpdater.quitAndInstall(), 2000);
    });
}

module.exports = { setupAutoUpdater, autoUpdater };
