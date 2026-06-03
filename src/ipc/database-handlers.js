/**
 * IPC Handlers — Database Operations
 *
 * Handles: db-get, db-set, db-delete, db-get-encrypted,
 *          db-set-encrypted, download-database, import-database
 */
const { ipcMain, dialog, app } = require('electron');
const path = require('node:path');
const fs = require('fs');

/**
 * @param {import('../database')} db           — DatabaseManager instance
 * @param {() => BrowserWindow}   getMainWindow
 */
function registerDatabaseIPC(db, getMainWindow) {
    /* ---------------------------------------------------------------- */
    /*  CRUD                                                             */
    /* ---------------------------------------------------------------- */

    ipcMain.handle('db-get', async (_event, key) => {
        try {
            const value = await db.get(key);
            return { success: true, value };
        } catch (error) {
            console.error('[DB] db-get error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db-set', async (_event, key, value) => {
        try {
            await db.set(key, value);
            return { success: true };
        } catch (error) {
            console.error('[DB] db-set error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db-delete', async (_event, key) => {
        try {
            await db.delete(key);
            return { success: true };
        } catch (error) {
            console.error('[DB] db-delete error:', error);
            return { success: false, error: error.message };
        }
    });

    /* ---------------------------------------------------------------- */
    /*  Encrypted storage                                                */
    /* ---------------------------------------------------------------- */

    ipcMain.handle('db-get-encrypted', async (_event, key) => {
        try {
            const value = await db.getEncrypted(key);
            return { success: true, value };
        } catch (error) {
            console.error('[DB] db-get-encrypted error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db-set-encrypted', async (_event, key, value) => {
        try {
            await db.setEncrypted(key, value);
            return { success: true };
        } catch (error) {
            console.error('[DB] db-set-encrypted error:', error);
            return { success: false, error: error.message };
        }
    });

    /* ---------------------------------------------------------------- */
    /*  Import / Export                                                   */
    /* ---------------------------------------------------------------- */

    ipcMain.handle('download-database', async () => {
        try {
            const mainWindow = getMainWindow();
            if (!mainWindow) return { success: false, error: 'Main window not found' };

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'Download Sessions',
                defaultPath: 'ghostli_sessions.db',
                filters: [{ name: 'Database Files', extensions: ['db'] }]
            });

            if (result.canceled || !result.filePath) {
                return { success: false, cancelled: true };
            }

            const dbPath = path.join(app.getPath('userData'), 'ghostli.db');
            fs.copyFileSync(dbPath, result.filePath);
            return { success: true };
        } catch (error) {
            console.error('[DB] download-database error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('import-database', async () => {
        try {
            const mainWindow = getMainWindow();
            if (!mainWindow) return { success: false, error: 'Main window not found' };

            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Import Sessions',
                filters: [{ name: 'Database Files', extensions: ['db'] }],
                properties: ['openFile']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return { success: false, cancelled: true };
            }

            const sourcePath = result.filePaths[0];
            const dbPath = path.join(app.getPath('userData'), 'ghostli.db');

            // Close current connection → replace file → relaunch
            await db.close();
            fs.copyFileSync(sourcePath, dbPath);
            app.relaunch();
            app.exit(0);

            return { success: true };
        } catch (error) {
            console.error('[DB] import-database error:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerDatabaseIPC };
