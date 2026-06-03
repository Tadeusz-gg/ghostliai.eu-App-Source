/**
 * IPC Handlers - Shell & External Navigation
 *
 * Handles: open-html-in-browser, open-external, open-path,
 *          get-workspace-launch-meta, open-workspace-in-editor,
 *          show-save-dialog, show-open-dialog
 */
const { ipcMain, shell, dialog, app } = require('electron');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');

const LAUNCH_META_VERSION = 2;

const KNOWN_EDITOR_LOOKUP = {
    vscode: {
        appName: 'VS Code',
        execNames: ['Code.exe', 'Code - Insiders.exe'],
        installPaths: [
            '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
            '%PROGRAMFILES%\\Microsoft VS Code\\Code.exe',
            '%PROGRAMFILES(X86)%\\Microsoft VS Code\\Code.exe',
            '%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
            '%PROGRAMFILES%\\Microsoft VS Code Insiders\\Code - Insiders.exe'
        ]
    },
    vscodium: {
        appName: 'VSCodium',
        execNames: ['VSCodium.exe'],
        installPaths: [
            '%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe',
            '%PROGRAMFILES%\\VSCodium\\VSCodium.exe',
            '%PROGRAMFILES(X86)%\\VSCodium\\VSCodium.exe'
        ]
    },
    cursor: {
        appName: 'Cursor',
        execNames: ['Cursor.exe'],
        installPaths: [
            '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
            '%PROGRAMFILES%\\Cursor\\Cursor.exe',
            '%PROGRAMFILES(X86)%\\Cursor\\Cursor.exe'
        ]
    },
    windsurf: {
        appName: 'Windsurf',
        execNames: ['Windsurf.exe'],
        installPaths: [
            '%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe',
            '%PROGRAMFILES%\\Windsurf\\Windsurf.exe',
            '%PROGRAMFILES(X86)%\\Windsurf\\Windsurf.exe'
        ]
    },
    visualstudio: {
        appName: 'Visual Studio',
        execNames: ['VSLauncher.exe', 'devenv.exe'],
        installPaths: [
            '%PROGRAMFILES(X86)%\\Common Files\\Microsoft Shared\\MSEnv\\VSLauncher.exe',
            '%PROGRAMFILES%\\Common Files\\Microsoft Shared\\MSEnv\\VSLauncher.exe'
        ]
    },
    jetbrains: {
        appName: 'JetBrains IDE',
        execNames: ['idea64.exe', 'rider64.exe', 'webstorm64.exe', 'pycharm64.exe', 'clion64.exe', 'phpstorm64.exe', 'goland64.exe', 'datagrip64.exe', 'fleet.exe', 'studio64.exe'],
        installPaths: []
    }
};

function execFileAsync(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function getEnvValue(name) {
    return process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()] || '';
}

function expandEnvPath(filePath) {
    return String(filePath || '').replace(/%([^%]+)%/g, (_match, envName) => getEnvValue(envName));
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch (_error) {
        return false;
    }
}

function parseRegistryValue(rawOutput) {
    const entries = parseRegistryEntries(rawOutput);
    return entries.length > 0 ? entries[0].data : null;
}

function parseRegistryEntries(rawOutput) {
    return String(rawOutput || '')
        .split(/\r?\n/)
        .map(line => line.match(/^\s*(.+?)\s{2,}(REG_[A-Z0-9_]+)(?:\s{2,}(.*))?$/i))
        .filter(Boolean)
        .map((match) => ({
            name: String(match[1] || '').trim(),
            type: String(match[2] || '').trim(),
            data: String(match[3] || '').trim()
        }));
}

function parseRegistrySubkeys(rawOutput, keyPath) {
    const normalizedRoot = String(keyPath || '').trim().toLowerCase();
    return String(rawOutput || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^hkey_/i.test(line))
        .filter(line => line.toLowerCase() !== normalizedRoot);
}

async function readRegistryValue(keyPath, valueName = null) {
    try {
        const args = ['query', keyPath];
        if (valueName === null) args.push('/ve');
        else args.push('/v', valueName);
        const { stdout } = await execFileAsync('reg.exe', args);
        return parseRegistryValue(stdout);
    } catch (_error) {
        return null;
    }
}

async function readRegistryEntries(keyPath) {
    try {
        const { stdout } = await execFileAsync('reg.exe', ['query', keyPath]);
        return parseRegistryEntries(stdout);
    } catch (_error) {
        return [];
    }
}

async function readRegistrySubkeys(keyPath) {
    try {
        const { stdout } = await execFileAsync('reg.exe', ['query', keyPath]);
        return parseRegistrySubkeys(stdout, keyPath);
    } catch (_error) {
        return [];
    }
}

async function resolveRegisteredExecutable(execName) {
    const registrationKeys = [
        `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${execName}`,
        `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${execName}`,
        `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${execName}`
    ];

    for (const keyPath of registrationKeys) {
        const registeredPath = await readRegistryValue(keyPath);
        if (registeredPath && await pathExists(registeredPath)) return registeredPath;
    }

    try {
        const { stdout } = await execFileAsync('where.exe', [execName]);
        const foundPath = String(stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (foundPath && await pathExists(foundPath)) return foundPath;
    } catch (_error) {
    }

    return null;
}

async function resolveKnownEditorExecutable(appId) {
  const lookup = KNOWN_EDITOR_LOOKUP[appId];
  if (!lookup) return null;

    for (const execName of lookup.execNames || []) {
        const registeredPath = await resolveRegisteredExecutable(execName);
        if (registeredPath) return registeredPath;
    }

    for (const templatePath of lookup.installPaths || []) {
        const expandedPath = expandEnvPath(templatePath);
        if (expandedPath && await pathExists(expandedPath)) return expandedPath;
    }

  return null;
}

async function resolveFirstInstalledEditor(appIds) {
    for (const appId of appIds || []) {
        const executablePath = await resolveKnownEditorExecutable(appId);
        if (executablePath) {
            return {
                appId,
                appName: (KNOWN_EDITOR_LOOKUP[appId] && KNOWN_EDITOR_LOOKUP[appId].appName) || appId,
                executablePath
            };
        }
    }

    return null;
}

function extractExecutableFromCommand(command) {
    const normalizedCommand = String(command || '').trim();
    if (!normalizedCommand) return null;

    let match = normalizedCommand.match(/^"([^"]+?\.exe)"/i);
    if (match) return match[1];

    match = normalizedCommand.match(/^([^"\s]+?\.exe)/i);
    return match ? match[1] : null;
}

async function resolveExecutableFromSources({ executablePath = '', command = '', execName = '' }) {
    let resolvedExecutablePath = String(executablePath || '').trim();
    if (!resolvedExecutablePath && command) {
        resolvedExecutablePath = extractExecutableFromCommand(command) || '';
    }

    if (resolvedExecutablePath) {
        resolvedExecutablePath = expandEnvPath(resolvedExecutablePath);
        if (await pathExists(resolvedExecutablePath)) return resolvedExecutablePath;
        const registeredFromExtracted = await resolveRegisteredExecutable(path.basename(resolvedExecutablePath));
        if (registeredFromExtracted) return registeredFromExtracted;
    }

    if (execName) {
        const registeredFromName = await resolveRegisteredExecutable(execName);
        if (registeredFromName) return registeredFromName;
    }

    return null;
}

function formatExecutableAppName(executablePath, fallbackAppName = 'Custom editor') {
    const rawName = path.basename(String(executablePath || ''), path.extname(String(executablePath || ''))).trim();
    if (!rawName) return fallbackAppName;

    return rawName
        .replace(/[-_]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function buildCustomAppMeta(executablePath, fallbackAppId = 'system', fallbackAppName = 'Custom editor') {
    const rawName = path.basename(String(executablePath || ''), path.extname(String(executablePath || ''))).trim();
    const normalizedName = rawName.toLowerCase();
    const slug = normalizedName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-editor';
    const likelyEditorPattern = /(notepad\+\+|notepadpp|vim|gvim|nvim|helix|hx|emacs|sublime|zed|nova|kate|geany|lapce|lite-xl|textadept|bbedit|code|cursor|windsurf|codium|fleet|jetbrains|idea|pycharm|webstorm|clion|rider)/i;

    return {
        launchAppId: `custom:${slug}`,
        launchAppName: formatExecutableAppName(executablePath, fallbackAppName),
        isCodeEditor: fallbackAppId !== 'system' || likelyEditorPattern.test(rawName)
    };
}

function createLaunchOptionKey(meta) {
    const rawKey = JSON.stringify({
        appId: String(meta && meta.launchAppId ? meta.launchAppId : 'system').toLowerCase(),
        target: String(meta && meta.launchTarget ? meta.launchTarget : ''),
        executable: String(meta && meta.launchExecutable ? meta.launchExecutable : ''),
        mode: String(meta && meta.launchMode ? meta.launchMode : 'shell').toLowerCase()
    });

    return Buffer.from(rawKey, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function inferLaunchAppMeta({ executablePath = '', command = '', progId = '', fallbackAppId = 'system', fallbackAppName = 'System default' }) {
    const resolvedExecutablePath = executablePath || extractExecutableFromCommand(command);
    const signature = `${path.basename(resolvedExecutablePath || '').toLowerCase()} ${String(command || '').toLowerCase()} ${String(progId || '').toLowerCase()}`;

    if (signature.includes('cursor.exe')) {
        return { launchAppId: 'cursor', launchAppName: 'Cursor', isCodeEditor: true };
    }

    if (signature.includes('windsurf.exe')) {
        return { launchAppId: 'windsurf', launchAppName: 'Windsurf', isCodeEditor: true };
    }

    if (signature.includes('vscodium.exe')) {
        return { launchAppId: 'vscodium', launchAppName: 'VSCodium', isCodeEditor: true };
    }

    if (signature.includes('code.exe') || signature.includes('code - insiders.exe') || signature.includes('vscode')) {
        return { launchAppId: 'vscode', launchAppName: 'VS Code', isCodeEditor: true };
    }

    if (signature.includes('visualstudio') || signature.includes('devenv.exe') || signature.includes('vslauncher.exe')) {
        return { launchAppId: 'visualstudio', launchAppName: 'Visual Studio', isCodeEditor: true };
    }

    if (signature.includes('idea64.exe') || signature.includes('rider64.exe') || signature.includes('webstorm64.exe') || signature.includes('pycharm64.exe') || signature.includes('clion64.exe') || signature.includes('phpstorm64.exe') || signature.includes('goland64.exe') || signature.includes('datagrip64.exe') || signature.includes('fleet.exe') || signature.includes('studio64.exe') || signature.includes('jetbrains')) {
        return { launchAppId: 'jetbrains', launchAppName: 'JetBrains IDE', isCodeEditor: true };
    }

    if (signature.includes('xcode')) {
        return { launchAppId: 'xcode', launchAppName: 'Xcode', isCodeEditor: true };
    }

    if (resolvedExecutablePath) {
        return buildCustomAppMeta(resolvedExecutablePath, fallbackAppId, fallbackAppName);
    }

    if (fallbackAppId && fallbackAppId !== 'system') {
        return { launchAppId: fallbackAppId, launchAppName: fallbackAppName, isCodeEditor: true };
    }

    return { launchAppId: 'system', launchAppName: fallbackAppName, isCodeEditor: false };
}

async function resolveWindowsAssociation(extension, fallbackAppId, fallbackAppName) {
    if (!extension) {
        return inferLaunchAppMeta({ fallbackAppId, fallbackAppName });
    }

    const userChoiceKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`;
    const progId = await readRegistryValue(userChoiceKey, 'ProgId') || await readRegistryValue(`HKCR\\${extension}`);
    const command = progId ? await readRegistryValue(`HKCR\\${progId}\\shell\\open\\command`) : null;
    const executablePath = command ? extractExecutableFromCommand(command) : null;

    return {
        progId,
        command,
        executablePath,
        ...inferLaunchAppMeta({ executablePath, command, progId, fallbackAppId, fallbackAppName })
    };
}

async function readOpenWithProgIds(extension) {
    const keys = [
        `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\OpenWithProgids`,
        `HKCR\\${extension}\\OpenWithProgids`
    ];
    const progIds = new Set();

    for (const keyPath of keys) {
        const entries = await readRegistryEntries(keyPath);
        entries.forEach((entry) => {
            const progId = String(entry && entry.name ? entry.name : '').trim();
            if (progId && progId !== '(Default)') progIds.add(progId);
        });
    }

    return [...progIds];
}

async function readOpenWithExecutables(extension) {
    const keys = [
        `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\OpenWithList`,
        `HKCR\\${extension}\\OpenWithList`
    ];
    const executables = new Set();

    for (const keyPath of keys) {
        const entries = await readRegistryEntries(keyPath);
        entries.forEach((entry) => {
            const valueName = String(entry && entry.name ? entry.name : '').trim();
            const data = String(entry && entry.data ? entry.data : '').trim();
            const candidate = /\.exe$/i.test(data) ? data : (/\.exe$/i.test(valueName) ? valueName : '');
            if (candidate && !/^mru(list)?$/i.test(valueName)) executables.add(candidate);
        });

        const subkeys = await readRegistrySubkeys(keyPath);
        subkeys.forEach((subkeyPath) => {
            const executableName = String(subkeyPath || '').split('\\').pop();
            if (/\.exe$/i.test(executableName)) executables.add(executableName);
        });
    }

    return [...executables];
}

async function buildDetectedEditorMeta(candidate, { executablePath = '', command = '', execName = '', progId = '' } = {}) {
    const resolvedExecutablePath = await resolveExecutableFromSources({ executablePath, command, execName });
    if (!resolvedExecutablePath) return null;

    const inferred = inferLaunchAppMeta({
        executablePath: resolvedExecutablePath,
        command,
        progId,
        fallbackAppId: candidate.fallbackAppId,
        fallbackAppName: candidate.fallbackAppName
    });

    return {
        ...candidate,
        launchAppId: inferred.launchAppId,
        launchAppName: inferred.launchAppName,
        isCodeEditor: inferred.isCodeEditor,
        launchMode: 'command',
        launchExecutable: resolvedExecutablePath,
        launchMetaVersion: LAUNCH_META_VERSION
    };
}

async function discoverWindowsEditorsForCandidate(candidate) {
    if (!candidate || !candidate.assocExt) return [];

    const options = [];
    const seen = new Set();
    const logicalIndex = new Map();
    const pushDiscovered = async (metaPromise) => {
        const meta = await metaPromise;
        if (!meta || !meta.launchExecutable) return;
        const key = `${String(meta.launchAppId || '').toLowerCase()}::${String(meta.launchTarget || '')}::${String(meta.launchExecutable || '').toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        options.push(meta);
    };

    const association = await resolveWindowsAssociation(candidate.assocExt, candidate.fallbackAppId, candidate.fallbackAppName);
    await pushDiscovered(buildDetectedEditorMeta(candidate, {
        executablePath: association.executablePath,
        command: association.command,
        progId: association.progId
    }));

    const openWithProgIds = await readOpenWithProgIds(candidate.assocExt);
    for (const progId of openWithProgIds) {
        const command = await readRegistryValue(`HKCR\\${progId}\\shell\\open\\command`);
        await pushDiscovered(buildDetectedEditorMeta(candidate, { command, progId }));
    }

    const openWithExecutables = await readOpenWithExecutables(candidate.assocExt);
    for (const execName of openWithExecutables) {
        const command = await readRegistryValue(`HKCR\\Applications\\${execName}\\shell\\open\\command`);
        await pushDiscovered(buildDetectedEditorMeta(candidate, { command, execName }));
    }

    return options;
}

async function buildWorkspaceCandidates(workspacePath) {
    const entries = await fs.readdir(workspacePath, { withFileTypes: true });
    const files = entries.filter(entry => !entry.isDirectory());
    const directoryNames = new Set(entries.filter(entry => entry.isDirectory()).map(entry => String(entry.name || '').toLowerCase()));
    const findFile = predicate => files.find(entry => predicate(String(entry.name || '').toLowerCase()));
    const candidates = [];

    const codeWorkspace = findFile(name => name.endsWith('.code-workspace'));
    if (codeWorkspace) {
        candidates.push({
            kind: 'workspace-file',
            launchTarget: path.join(workspacePath, codeWorkspace.name),
            assocExt: '.code-workspace',
            fallbackAppId: 'vscode',
            fallbackAppName: 'VS Code',
            preferCommandLaunch: false
        });
    }

    const solutionFile = findFile(name => name.endsWith('.sln'));
    if (solutionFile) {
        candidates.push({
            kind: 'solution',
            launchTarget: path.join(workspacePath, solutionFile.name),
            assocExt: '.sln',
            fallbackAppId: 'visualstudio',
            fallbackAppName: 'Visual Studio',
            preferCommandLaunch: false
        });
    }

    const xcodeProject = findFile(name => name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj'));
    if (xcodeProject) {
        candidates.push({
            kind: 'xcode',
            launchTarget: path.join(workspacePath, xcodeProject.name),
            assocExt: path.extname(xcodeProject.name).toLowerCase(),
            fallbackAppId: 'xcode',
            fallbackAppName: 'Xcode',
            preferCommandLaunch: false
        });
    }

    const jetbrainsProject = findFile(name => name.endsWith('.iml'));
    if (jetbrainsProject) {
        candidates.push({
            kind: 'jetbrains-file',
            launchTarget: path.join(workspacePath, jetbrainsProject.name),
            assocExt: '.iml',
            fallbackAppId: 'jetbrains',
            fallbackAppName: 'JetBrains IDE',
            preferCommandLaunch: false
        });
    }

    if (directoryNames.has('.vscode')) {
        candidates.push({
            kind: 'vscode-folder',
            launchTarget: workspacePath,
            assocExt: '.code-workspace',
            fallbackAppId: 'vscode',
            fallbackAppName: 'VS Code',
            preferCommandLaunch: true
        });
    }

    if (directoryNames.has('.idea')) {
        candidates.push({
            kind: 'idea-folder',
            launchTarget: workspacePath,
            assocExt: '.iml',
            fallbackAppId: 'jetbrains',
            fallbackAppName: 'JetBrains IDE',
            preferCommandLaunch: true
        });
    }

    candidates.push({
        kind: 'folder',
        launchTarget: workspacePath,
        assocExt: '.code-workspace',
        fallbackAppId: 'system',
        fallbackAppName: 'System default',
        preferCommandLaunch: true
    });

    return candidates;
}

async function resolveWorkspaceCandidate(candidate) {
    if (process.platform !== 'win32') {
        return {
            ...candidate,
            launchAppId: candidate.fallbackAppId,
            launchAppName: candidate.fallbackAppName,
            isCodeEditor: candidate.fallbackAppId !== 'system',
            launchMode: 'shell',
            launchExecutable: null,
            launchMetaVersion: LAUNCH_META_VERSION
        };
    }

    const association = await resolveWindowsAssociation(candidate.assocExt, candidate.fallbackAppId, candidate.fallbackAppName);
    let launchAppId = association.launchAppId;
    let launchAppName = association.launchAppName;
    let isCodeEditor = association.isCodeEditor;
    let launchMode = 'shell';
    let launchExecutable = null;

    if (candidate.preferCommandLaunch && association.isCodeEditor) {
        const preferredEditor = association.executablePath
            ? { appId: launchAppId, appName: launchAppName, executablePath: association.executablePath }
            : await resolveFirstInstalledEditor([launchAppId]);

        if (preferredEditor && preferredEditor.executablePath) {
            launchAppId = preferredEditor.appId;
            launchAppName = preferredEditor.appName;
            isCodeEditor = true;
            launchMode = 'command';
            launchExecutable = preferredEditor.executablePath;
        }
    }

    if (launchMode !== 'command' && !association.command) {
        const folderEditorFallbacks = candidate.preferCommandLaunch
            ? ['vscode', 'cursor', 'windsurf', 'vscodium']
            : [];
        const editorFallbacks = candidate.fallbackAppId !== 'system'
            ? [candidate.fallbackAppId]
            : [];
        const fallbackEditor = await resolveFirstInstalledEditor([...editorFallbacks, ...folderEditorFallbacks.filter(appId => !editorFallbacks.includes(appId))]);

        if (fallbackEditor) {
            launchAppId = fallbackEditor.appId;
            launchAppName = fallbackEditor.appName;
            isCodeEditor = true;
            launchMode = 'command';
            launchExecutable = fallbackEditor.executablePath;
        } else {
            launchAppId = 'system';
            launchAppName = 'System default';
            isCodeEditor = false;
        }
    }

    return {
        ...candidate,
        launchAppId,
        launchAppName,
        isCodeEditor,
        launchMode,
        launchExecutable,
        launchMetaVersion: LAUNCH_META_VERSION
    };
}

function pickPreferredWorkspaceCandidate(candidates, workspacePath) {
    const fallback = candidates.find(candidate => candidate.launchTarget === workspacePath)
        || candidates[0]
        || {
            launchTarget: workspacePath,
            launchAppName: 'System default',
            launchAppId: 'system',
            isCodeEditor: false,
            launchMode: 'shell',
            launchExecutable: null,
            launchMetaVersion: LAUNCH_META_VERSION
        };

    return candidates.find(candidate => candidate.kind === 'solution' && candidate.launchAppId === 'visualstudio')
        || candidates.find(candidate => candidate.kind === 'xcode' && candidate.launchAppId === 'xcode')
        || candidates.find(candidate => (candidate.kind === 'jetbrains-file' || candidate.kind === 'idea-folder') && candidate.launchAppId === 'jetbrains')
        || candidates.find(candidate => candidate.kind === 'workspace-file' && candidate.isCodeEditor)
        || candidates.find(candidate => candidate.isCodeEditor && candidate.launchMode === 'command')
        || candidates.find(candidate => candidate.isCodeEditor)
        || fallback;
}

function getWorkspaceEditorCandidateForApp(appId, candidates, workspacePath) {
    const list = Array.isArray(candidates) ? candidates : [];
    const findByKinds = (...kinds) => list.find(candidate => kinds.includes(candidate.kind));
    const folderCandidate = findByKinds('folder') || {
        kind: 'folder',
        launchTarget: workspacePath,
        assocExt: '.code-workspace',
        fallbackAppId: 'system',
        fallbackAppName: 'System default',
        preferCommandLaunch: true
    };

    switch (String(appId || '').toLowerCase()) {
        case 'visualstudio':
            return findByKinds('solution') || folderCandidate;
        case 'jetbrains':
            return findByKinds('jetbrains-file', 'idea-folder') || folderCandidate;
        case 'xcode':
            return findByKinds('xcode') || folderCandidate;
        case 'vscode':
        case 'vscodium':
        case 'cursor':
        case 'windsurf':
            return findByKinds('workspace-file', 'vscode-folder', 'folder') || folderCandidate;
        default:
            return folderCandidate;
    }
}

async function getWorkspaceLaunchMetaInternal(workspacePath) {
    const defaultMeta = {
        launchTarget: workspacePath,
        launchAppName: 'System default',
        launchAppId: 'system',
        isCodeEditor: false,
        launchMode: 'shell',
        launchExecutable: null,
        launchMetaVersion: LAUNCH_META_VERSION
    };

    if (!workspacePath) return defaultMeta;

    try {
        const candidates = await buildWorkspaceCandidates(workspacePath);
        const resolvedCandidates = [];
        for (const candidate of candidates) {
            resolvedCandidates.push(await resolveWorkspaceCandidate(candidate));
        }
        const selectedMeta = pickPreferredWorkspaceCandidate(resolvedCandidates, workspacePath);
        return attachLaunchIcon(selectedMeta);
    } catch (error) {
        console.warn('[Shell] Failed to resolve workspace launch meta:', error);
        return attachLaunchIcon(defaultMeta);
    }
}

async function getWorkspaceEditorOptionsInternal(workspacePath) {
    if (!workspacePath) return [];

    let candidates = [];
    try {
        candidates = await buildWorkspaceCandidates(workspacePath);
    } catch (_error) {
        candidates = [];
    }

    const resolvedCandidates = [];
    for (const candidate of candidates) {
        resolvedCandidates.push(await resolveWorkspaceCandidate(candidate));
    }

    const selectedMeta = pickPreferredWorkspaceCandidate(resolvedCandidates, workspacePath);

    const options = [];
    const seen = new Set();
    const logicalIndex = new Map();

    const pushOption = async (meta, { isCurrent = false } = {}) => {
        if (!meta || !meta.launchTarget) return;

        const preparedMeta = await attachLaunchIcon({
            launchMetaVersion: LAUNCH_META_VERSION,
            ...meta
        });

        const logicalKey = `${String(preparedMeta.launchAppId || 'system').toLowerCase()}::${String(preparedMeta.launchTarget || '')}`;
        const key = `${logicalKey}::${String(preparedMeta.launchExecutable || '').toLowerCase()}`;
        if (seen.has(key)) return;
        const optionPayload = {
            ...preparedMeta,
            isCurrent: Boolean(
                isCurrent
                || (
                    preparedMeta.launchAppId === selectedMeta.launchAppId
                    && preparedMeta.launchTarget === selectedMeta.launchTarget
                )
            )
        };

        if (logicalIndex.has(logicalKey)) {
            const existingIndex = logicalIndex.get(logicalKey);
            const existingOption = options[existingIndex];
            const shouldReplaceExisting = !!(preparedMeta.launchExecutable && !(existingOption && existingOption.launchExecutable));

            if (shouldReplaceExisting) {
                options[existingIndex] = optionPayload;
                seen.add(key);
            } else if (optionPayload.isCurrent && existingOption) {
                options[existingIndex] = {
                    ...existingOption,
                    isCurrent: true
                };
            }
            return;
        }

        seen.add(key);
        logicalIndex.set(logicalKey, options.length);
        options.push(optionPayload);
    };

    await pushOption(selectedMeta, { isCurrent: true });

    for (const candidate of candidates) {
        const discoveredEditors = process.platform === 'win32'
            ? await discoverWindowsEditorsForCandidate(candidate)
            : [];
        for (const editorMeta of discoveredEditors) {
            await pushOption(editorMeta);
        }
    }

    if (options.length <= 1) {
        const editorPriority = process.platform === 'darwin'
            ? ['cursor', 'windsurf', 'vscode', 'vscodium', 'jetbrains', 'xcode']
            : ['cursor', 'windsurf', 'vscode', 'vscodium', 'visualstudio', 'jetbrains'];

        for (const appId of editorPriority) {
            const executablePath = await resolveKnownEditorExecutable(appId);
            if (!executablePath) continue;

            const candidate = getWorkspaceEditorCandidateForApp(appId, candidates, workspacePath);
            if (!candidate || !candidate.launchTarget) continue;

            await pushOption({
                ...candidate,
                launchAppId: appId,
                launchAppName: (KNOWN_EDITOR_LOOKUP[appId] && KNOWN_EDITOR_LOOKUP[appId].appName) || appId,
                isCodeEditor: true,
                launchMode: 'command',
                launchExecutable: executablePath,
                launchMetaVersion: LAUNCH_META_VERSION
            });
        }
    }

    await pushOption({
        launchTarget: selectedMeta.launchTarget || workspacePath,
        launchAppName: 'System default',
        launchAppId: 'system',
        isCodeEditor: false,
        launchMode: 'shell',
        launchExecutable: null
    });

    return options;
}

async function attachLaunchIcon(meta) {
    const iconSourcePath = meta && (meta.launchExecutable || meta.launchTarget);
    if (!meta || !iconSourcePath || !app || !app.getFileIcon) return meta;

    try {
        const icon = await app.getFileIcon(iconSourcePath, { size: 'small' });
        if (icon && !icon.isEmpty()) {
            return {
                ...meta,
                launchAppIconDataUrl: icon.toDataURL()
            };
        }
    } catch (_error) {
    }

    return meta;
}

function serializeLaunchMeta(meta) {
    return {
        launchTarget: meta.launchTarget,
        launchAppName: meta.launchAppName,
        launchAppId: meta.launchAppId,
        launchOptionKey: createLaunchOptionKey(meta),
        isCodeEditor: meta.isCodeEditor,
        launchMode: meta.launchMode || 'shell',
        launchExecutable: meta.launchExecutable || null,
        launchMetaVersion: meta.launchMetaVersion || LAUNCH_META_VERSION,
        launchAppIconDataUrl: meta.launchAppIconDataUrl || null,
        ...(typeof meta.isCurrent === 'boolean' ? { isCurrent: meta.isCurrent } : {})
    };
}

async function openWorkspaceLaunchMeta(meta) {
    if (!meta || !meta.launchTarget) {
        return { success: false, error: 'Missing workspace launch target.' };
    }

    try {
        if (meta.launchMode === 'command' && meta.launchExecutable) {
            const child = spawn(meta.launchExecutable, [meta.launchTarget], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
            return { success: true, meta: serializeLaunchMeta(meta) };
        }

        const result = await shell.openPath(meta.launchTarget);
        if (result) return { success: false, error: result, meta: serializeLaunchMeta(meta) };
        return { success: true, meta: serializeLaunchMeta(meta) };
    } catch (error) {
        console.error('[Shell] open workspace launch meta failed:', error);
        return { success: false, error: error.message, meta: serializeLaunchMeta(meta) };
    }
}

/**
 * @param {() => BrowserWindow} getMainWindow
 */
function registerShellIPC(getMainWindow) {
    // Open raw HTML in the user's default browser via a temporary local server
    ipcMain.handle('open-html-in-browser', async (_event, htmlContent) => {
        try {
            let fullHtml = htmlContent;
            if (!fullHtml.includes('<!DOCTYPE html>')) {
                fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ghostli HTML Preview</title>
</head>
<body>
${fullHtml}
</body>
</html>`;
            }

            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fullHtml);
            });

            server.listen(0, () => {
                const port = server.address().port;
                console.log(`[Shell] HTML preview at http://localhost:${port}`);
                shell.openExternal(`http://localhost:${port}`);
                // Auto-close server after 5 s (browser will have fetched the content)
                setTimeout(() => server.close(), 5000);
            });

            return { success: true };
        } catch (error) {
            console.error('[Shell] open-html-in-browser failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Open a URL in the default browser
    ipcMain.handle('open-external', async (_event, url) => {
        try {
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            console.error('[Shell] open-external failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Open a local path (folder / file) in the OS default handler
    ipcMain.handle('open-path', async (_event, targetPath) => {
        try {
            const result = await shell.openPath(targetPath);
            if (result) return { success: false, error: result };
            return { success: true };
        } catch (error) {
            console.error('[Shell] open-path failed:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-workspace-launch-meta', async (_event, workspacePath) => {
        const meta = await getWorkspaceLaunchMetaInternal(workspacePath);
        return { success: true, meta: serializeLaunchMeta(meta) };
    });

    ipcMain.handle('get-workspace-editor-options', async (_event, workspacePath) => {
        const options = await getWorkspaceEditorOptionsInternal(workspacePath);
        return { success: true, options: options.map(option => serializeLaunchMeta(option)) };
    });

    ipcMain.handle('open-workspace-in-editor', async (_event, workspacePath) => {
        const meta = await getWorkspaceLaunchMetaInternal(workspacePath);
        return openWorkspaceLaunchMeta(meta);
    });

    ipcMain.handle('open-workspace-in-specific-editor', async (_event, workspacePath, optionRef) => {
        const options = await getWorkspaceEditorOptionsInternal(workspacePath);
        const rawRef = String(optionRef || 'system').trim();
        const normalizedRef = rawRef.toLowerCase();
        const selectedOption = options.find(option => String(createLaunchOptionKey(option)) === rawRef)
            || options.find(option => String(option.launchOptionKey || '') === rawRef)
            || options.find(option => String(option.launchAppId || '').toLowerCase() === normalizedRef);

        if (!selectedOption) {
            return { success: false, error: 'Requested editor is not available for this workspace.' };
        }

        return openWorkspaceLaunchMeta(selectedOption);
    });

    ipcMain.handle('open-workspace-with-custom-editor', async (_event, workspacePath, executablePath, launchTarget = null, appName = '') => {
        const normalizedExecutablePath = String(executablePath || '').trim();
        if (!normalizedExecutablePath) {
            return { success: false, error: 'Missing editor executable path.' };
        }

        if (!await pathExists(normalizedExecutablePath)) {
            return { success: false, error: 'The selected editor executable could not be found.' };
        }

        const targetPath = String(launchTarget || workspacePath || '').trim();
        if (!targetPath) {
            return { success: false, error: 'Missing workspace launch target.' };
        }

        const customMeta = buildCustomAppMeta(normalizedExecutablePath, 'custom', appName || 'Custom editor');
        const preparedMeta = await attachLaunchIcon({
            launchTarget: targetPath,
            launchAppName: String(appName || '').trim() || customMeta.launchAppName,
            launchAppId: customMeta.launchAppId,
            isCodeEditor: true,
            launchMode: 'command',
            launchExecutable: normalizedExecutablePath,
            launchMetaVersion: LAUNCH_META_VERSION
        });

        return openWorkspaceLaunchMeta(preparedMeta);
    });

    // Native OS Save dialog
    ipcMain.handle('show-save-dialog', async (_event, options) => {
        try {
            return await dialog.showSaveDialog(getMainWindow(), options);
        } catch (err) {
            return { canceled: true, error: err.message };
        }
    });

    // Native OS Open dialog
    ipcMain.handle('show-open-dialog', async (_event, options) => {
        try {
            return await dialog.showOpenDialog(getMainWindow(), options);
        } catch (err) {
            return { canceled: true, error: err.message };
        }
    });
}

module.exports = { registerShellIPC };
