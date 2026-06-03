const { contextBridge, ipcRenderer } = require('electron');

const blockDevTools = () => {
  try {
    delete window.console;
    window.console = {
      log: () => { },
      warn: () => { },
      error: () => { },
      info: () => { },
      debug: () => { },
      table: () => { },
      group: () => { },
      groupEnd: () => { },
      time: () => { },
      timeEnd: () => { },
      trace: () => { },
      profile: () => { },
      profileEnd: () => { },
      memory: {},
      clear: () => { }
    };
  } catch (e) {
  }

  const originalEval = window.eval;
  window.eval = function () {
    return undefined;
  };

  const originalFunction = window.Function;
  window.Function = function () {
    return undefined;
  };
};

blockDevTools();

contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.send('minimizewindow'),
  close: () => ipcRenderer.send('closewindow'),
  resizeWindow: (size) => ipcRenderer.send('resize-window', size),
  reload: () => ipcRenderer.send('reload-app'),
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
});

contextBridge.exposeInMainWorld("electronAPI", {
  getOSInfo: () => ipcRenderer.invoke('get-os-info'),
  focusApp: () => ipcRenderer.send("focus-app"),
  runCommand: (command, cwd, options) => ipcRenderer.invoke("run-command", command, cwd, options),
  terminalStart: (command, cwd, options) => ipcRenderer.invoke("terminal-start", command, cwd, options),
  terminalWrite: (sessionId, input, options) => ipcRenderer.invoke("terminal-write", sessionId, input, options),
  terminalRead: (sessionId, options) => ipcRenderer.invoke("terminal-read", sessionId, options),
  terminalStop: (sessionId, options) => ipcRenderer.invoke("terminal-stop", sessionId, options),
  openProjectTerminal: (workspacePath, options) => ipcRenderer.invoke("open-project-terminal", workspacePath, options),
  saveFile: (filePath, content) => ipcRenderer.invoke("save-file", filePath, content),
  workspaceReadFile: (workspaceRoot, relativePath) => ipcRenderer.invoke("workspace-read-file", workspaceRoot, relativePath),
  workspaceReadFileSmart: (workspaceRoot, relativePath, options) => ipcRenderer.invoke("workspace-read-file-smart", workspaceRoot, relativePath, options),
  workspaceWriteFile: (workspaceRoot, relativePath, content) => ipcRenderer.invoke("workspace-write-file", workspaceRoot, relativePath, content),
  workspaceDeletePath: (workspaceRoot, relativePath) => ipcRenderer.invoke("workspace-delete-path", workspaceRoot, relativePath),
  workspaceMkdir: (workspaceRoot, relativePath) => ipcRenderer.invoke("workspace-mkdir", workspaceRoot, relativePath),
  workspaceRenamePath: (workspaceRoot, fromRelativePath, toRelativePath) => ipcRenderer.invoke("workspace-rename-path", workspaceRoot, fromRelativePath, toRelativePath),
  workspaceStat: (workspaceRoot, relativePath) => ipcRenderer.invoke("workspace-stat", workspaceRoot, relativePath),
  showSaveDialog: (options) => ipcRenderer.invoke("show-save-dialog", options),
  showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),
  readDirectory: (dirPath) => ipcRenderer.invoke("read-directory", dirPath),
  readDirectoryShallow: (dirPath) => ipcRenderer.invoke("read-directory-shallow", dirPath),
  searchInFiles: (rootPath, query, extensions) => ipcRenderer.invoke("search-in-files", rootPath, query, extensions),
  findWorkspaceRoot: (filePath) => ipcRenderer.invoke("find-workspace-root", filePath),
  validateCodeSyntax: (extension, code) => ipcRenderer.invoke("validate-code-syntax", extension, code),
  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  readFileSmart: (filePath, options) => ipcRenderer.invoke("read-file-smart", filePath, options),
  openHtmlInBrowser: (htmlContent) => ipcRenderer.invoke("open-html-in-browser", htmlContent),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openPath: (path) => ipcRenderer.invoke("open-path", path),
  getWorkspaceLaunchMeta: (workspacePath) => ipcRenderer.invoke("get-workspace-launch-meta", workspacePath),
  getWorkspaceEditorOptions: (workspacePath) => ipcRenderer.invoke("get-workspace-editor-options", workspacePath),
  openWorkspaceInEditor: (workspacePath) => ipcRenderer.invoke("open-workspace-in-editor", workspacePath),
  openWorkspaceInSpecificEditor: (workspacePath, appId) => ipcRenderer.invoke("open-workspace-in-specific-editor", workspacePath, appId),
  openWorkspaceWithCustomEditor: (workspacePath, executablePath, launchTarget, appName) => ipcRenderer.invoke("open-workspace-with-custom-editor", workspacePath, executablePath, launchTarget, appName),
  onWindowResized: (callback) => ipcRenderer.on('window-resized', callback),
  onWindowResizedByUser: (callback) => ipcRenderer.on('window-resized-by-user', callback),
  onAlwaysOnTopChanged: (callback) => ipcRenderer.on('always-on-top-changed', callback),
  dbGet: (key) => ipcRenderer.invoke('db-get', key),
  dbSet: (key, value) => ipcRenderer.invoke('db-set', key, value),
  dbDelete: (key) => ipcRenderer.invoke('db-delete', key),
  dbGetEncrypted: (key) => ipcRenderer.invoke('db-get-encrypted', key),
  dbSetEncrypted: (key, value) => ipcRenderer.invoke('db-set-encrypted', key, value),
  downloadDatabase: () => ipcRenderer.invoke('download-database'),
  importDatabase: () => ipcRenderer.invoke('import-database'),
  findInPage: (text, options) => ipcRenderer.send('find-in-page', text, options),
  stopFindInPage: (action) => ipcRenderer.send('stop-find-in-page', action),
  onFoundInPage: (callback) => ipcRenderer.on('found-in-page', callback),
  startDiscordRPC: () => ipcRenderer.send('discord-rpc-start'),
  stopDiscordRPC: () => ipcRenderer.send('discord-rpc-stop'),
  performWebSearch: (query) => ipcRenderer.invoke('perform-web-search', query),
  performWebSearchesParallel: (queries) => ipcRenderer.invoke('perform-web-searches-parallel', queries),
  fetchPageContent: (url) => ipcRenderer.invoke('fetch-page-content', url),
  fetchPagesBatch: (urls) => ipcRenderer.invoke('fetch-pages-batch', urls),
  fetchPagesBatchRag: (urls) => ipcRenderer.invoke('fetch-pages-batch-rag', urls),
  quickPromptSubmit: (text) => ipcRenderer.send('quick-prompt-submit', text),
  quickPromptClose: () => ipcRenderer.send('quick-prompt-close'),
  onExecuteQuickPrompt: (callback) => ipcRenderer.on('execute-quick-prompt', callback),
  setAppLoggedInState: (state) => ipcRenderer.send('set-app-login-state', state),
  updateShortcuts: (settings) => ipcRenderer.send('update-shortcuts', settings),
  copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text)
});
