/**
 * IPC Handler Registry
 *
 * Single entry point that registers every IPC handler group.
 * Import this once in the main process and call registerAllIPC().
 */
const { registerWindowControlsIPC } = require('./window-controls');
const { registerCommandIPC } = require('./command-handlers');
const { registerFileSystemIPC } = require('./file-system');
const { registerWorkspaceIPC } = require('./workspace');
const { registerShellIPC } = require('./shell-handlers');
const { registerDatabaseIPC } = require('./database-handlers');
const { registerFindIPC } = require('./find-handlers');
const { registerWebSearchIPC } = require('./web-search');

/**
 * Registers all IPC handlers for the application.
 *
 * @param {object} deps
 * @param {() => BrowserWindow} deps.getMainWindow — getter for the main window
 * @param {import('../database')} deps.db          — DatabaseManager instance
 */
function registerAllIPC({ getMainWindow, db }) {
    registerWindowControlsIPC(getMainWindow);
    registerCommandIPC();
    registerFileSystemIPC();
    registerWorkspaceIPC();
    registerShellIPC(getMainWindow);
    registerDatabaseIPC(db, getMainWindow);
    registerFindIPC(getMainWindow);
    registerWebSearchIPC();
}

module.exports = { registerAllIPC };
