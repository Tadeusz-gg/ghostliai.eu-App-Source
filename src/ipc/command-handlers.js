/**
 * IPC Handlers - Command Execution
 *
 * Provides a sandboxed way for the renderer to execute
 * shell commands. Automatically detects the OS and uses
 * PowerShell on Windows and bash/sh on Linux/macOS.
 */
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COMMAND_TIMEOUT_MS = 180000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024 * 20;
const MAX_INTERACTIVE_OUTPUT_BYTES = 1024 * 512;
const DEFAULT_INTERACTIVE_WAIT_MS = 2500;
const interactiveTerminalSessions = new Map();

function resolveWindowsShell() {
    const shellCandidates = [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'powershell.exe'
    ];

    for (const candidate of shellCandidates) {
        try {
            if (candidate.includes('\\') && !fs.existsSync(candidate)) continue;
            return candidate;
        } catch (_error) {
        }
    }

    return 'powershell.exe';
}

/**
 * Detects the current platform and returns OS-specific info.
 * @returns {{ platform: string, shell: string, isWindows: boolean, isLinux: boolean, isMac: boolean }}
 */
function getOSInfo() {
    const platform = process.platform; // 'win32', 'linux', 'darwin'
    const isWindows = platform === 'win32';
    const isLinux = platform === 'linux';
    const isMac = platform === 'darwin';

    let shell;
    if (isWindows) {
        shell = resolveWindowsShell();
    } else {
        shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    }

    return { platform, shell, isWindows, isLinux, isMac };
}

function buildShellInvocation(command, osInfo, options = {}) {
    if (osInfo.isWindows) {
        const args = [
                '-NoLogo',
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                String(command || '')
        ];
        if (!options.interactive) {
            args.splice(2, 0, '-NonInteractive');
        }
        return {
            command: osInfo.shell,
            args
        };
    }

    return {
        command: osInfo.shell,
        args: osInfo.shell.endsWith('bash')
            ? ['-lc', String(command || '')]
            : ['-c', String(command || '')]
    };
}

function createTerminalSessionId() {
    return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trimInteractiveBuffer(session) {
    const totalBytes = Buffer.byteLength(session.output, 'utf8');
    if (totalBytes <= MAX_INTERACTIVE_OUTPUT_BYTES) return;
    const keep = Buffer.from(session.output, 'utf8').subarray(totalBytes - MAX_INTERACTIVE_OUTPUT_BYTES).toString('utf8');
    session.output = `[output truncated to last ${Math.round(MAX_INTERACTIVE_OUTPUT_BYTES / 1024)}KB]\n${keep}`;
}

function appendInteractiveOutput(session, stream, chunk) {
    const text = String(chunk || '');
    if (!text) return;
    session.seq += 1;
    session.output += text;
    session.chunks.push({ seq: session.seq, stream, text, ts: Date.now() });
    if (session.chunks.length > 400) {
        session.chunks = session.chunks.slice(-300);
    }
    trimInteractiveBuffer(session);
}

function getInteractiveSnapshot(session, options = {}) {
    const since = Number(options.since || 0);
    const maxBytes = Math.max(1024, Math.min(Number(options.maxBytes || 65536), MAX_INTERACTIVE_OUTPUT_BYTES));
    const chunks = session.chunks.filter((chunk) => chunk.seq > since);
    let output = chunks.map((chunk) => chunk.text).join('');
    if (!output) {
        output = session.output;
    }
    const bytes = Buffer.byteLength(output, 'utf8');
    if (bytes > maxBytes) {
        output = Buffer.from(output, 'utf8').subarray(bytes - maxBytes).toString('utf8');
        output = `[tail only]\n${output}`;
    }

    return {
        success: true,
        sessionId: session.id,
        command: session.originalCommand,
        cwd: session.cwd,
        running: !session.closed,
        code: session.exitCode,
        signal: session.signal,
        output,
        nextCursor: session.seq,
        startedAt: session.startedAt,
        closedAt: session.closedAt || null,
        pid: session.pid
    };
}

function stopProcessTree(child, osInfo) {
    return new Promise((resolve) => {
        if (!child || child.killed) {
            resolve();
            return;
        }

        if (osInfo.isWindows) {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
            killer.on('close', () => resolve());
            killer.on('error', () => {
                try {
                    child.kill();
                } catch (_error) {
                }
                resolve();
            });
            return;
        }

        try {
            if (child.pid) {
                process.kill(-child.pid, 'SIGINT');
            } else {
                child.kill('SIGINT');
            }
        } catch (_error) {
            try {
                child.kill('SIGTERM');
            } catch (__error) {
            }
        }
        setTimeout(resolve, 350);
    });
}

function fileExists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch (_error) {
        return false;
    }
}

function collectProjectDirectories(workspacePath) {
    const skipNames = new Set([
        '.git',
        '.hg',
        '.svn',
        'node_modules',
        'dist',
        'build',
        'out',
        '.next',
        '.nuxt',
        '.svelte-kit',
        'coverage',
        'target',
        'vendor',
        '__pycache__'
    ]);
    const markers = new Set(['package.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'app.py', 'main.py', 'index.html']);
    const found = new Set([path.resolve(workspacePath)]);
    const queue = [{ dir: path.resolve(workspacePath), depth: 0 }];
    const maxDepth = 4;
    let visited = 0;

    while (queue.length > 0 && visited < 1200) {
        const current = queue.shift();
        visited += 1;

        let entries = [];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch (_error) {
            continue;
        }

        if (entries.some((entry) => entry.isFile() && markers.has(entry.name))) {
            found.add(current.dir);
        }

        if (current.depth >= maxDepth) continue;

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (skipNames.has(entry.name) || entry.name.startsWith('.')) continue;
            queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
    }

    return Array.from(found);
}

function isPathInside(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function scoreProjectTerminalPath(projectPath, workspacePath, options = {}) {
    const rel = path.relative(workspacePath, projectPath);
    const depth = rel ? rel.split(path.sep).length : 0;
    let score = Math.max(0, 30 - depth * 4);
    const lowerRel = rel.toLowerCase();
    if (!rel) score += 8;
    if (/(^|[\\/])(app|client|frontend|web|site|desktop|project)([\\/]|$)/i.test(rel)) score += 10;
    if (/(^|[\\/])(example|examples|demo|docs|test|tests)([\\/]|$)/i.test(lowerRel)) score -= 12;

    const activeRelativePath = String(options.activeRelativePath || '').trim();
    if (activeRelativePath) {
        const activeAbsPath = path.resolve(workspacePath, activeRelativePath);
        if (activeAbsPath === projectPath || isPathInside(projectPath, activeAbsPath)) {
            score += 28;
        }
    }

    return score;
}

function inferProjectTerminalCwd(workspacePath, options = {}) {
    const workspaceRoot = path.resolve(workspacePath);
    return collectProjectDirectories(workspaceRoot)
        .map((projectPath) => ({
            cwd: projectPath,
            score: scoreProjectTerminalPath(projectPath, workspaceRoot, options)
        }))
        .sort((a, b) => b.score - a.score)[0]?.cwd || workspaceRoot;
}

function getUnixTerminalCommand(cwd, keepOpen = false) {
    return keepOpen
        ? `cd ${quoteForBash(cwd)}; exec bash`
        : `cd ${quoteForBash(cwd)}; clear`;
}

function quoteForCmd(value) {
    return `"${String(value || '').replace(/"/g, '""')}"`;
}

function quoteForBash(value) {
    return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function findLinuxTerminal() {
    const candidates = [
        { command: 'x-terminal-emulator', args: (shellCommand) => ['-e', 'bash', '-lc', shellCommand] },
        { command: 'gnome-terminal', args: (shellCommand) => ['--', 'bash', '-lc', shellCommand] },
        { command: 'konsole', args: (shellCommand) => ['-e', 'bash', '-lc', shellCommand] },
        { command: 'xfce4-terminal', args: (shellCommand) => ['--command', `bash -lc ${quoteForBash(shellCommand)}`] },
        { command: 'xterm', args: (shellCommand) => ['-e', 'bash', '-lc', shellCommand] }
    ];

    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    return candidates.find((candidate) => pathDirs.some((dir) => fileExists(path.join(dir, candidate.command))));
}

function openProjectTerminal(workspacePath, options = {}) {
    try {
        const workspaceRoot = path.resolve(String(workspacePath || ''));
        if (!workspaceRoot || !fileExists(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
            return { success: false, error: 'Workspace folder does not exist.' };
        }

        const cwd = inferProjectTerminalCwd(workspaceRoot, options);
        const osInfo = getOSInfo();
        let child;

        if (osInfo.isWindows) {
            child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `cd /d ${quoteForCmd(cwd)}`], {
                cwd,
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
        } else if (osInfo.isMac) {
            const shellCommand = getUnixTerminalCommand(cwd);
            child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(shellCommand)}`], {
                cwd,
                detached: true,
                stdio: 'ignore'
            });
        } else {
            const terminal = findLinuxTerminal();
            if (!terminal) {
                return { success: false, error: 'No supported Linux terminal was found.' };
            }
            const shellCommand = getUnixTerminalCommand(cwd, true);
            child = spawn(terminal.command, terminal.args(shellCommand), {
                cwd,
                detached: true,
                stdio: 'ignore'
            });
        }

        child.unref();
        return { success: true, cwd };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

async function startInteractiveTerminal(command, cwd, options = {}) {
    try {
        const osInfo = getOSInfo();
        const invocation = buildShellInvocation(command, osInfo, { interactive: true });
        const spawnOptions = {
            cwd: (cwd && fs.existsSync(cwd)) ? cwd : undefined,
            windowsHide: true,
            env: process.env,
            detached: !osInfo.isWindows
        };

        const child = spawn(invocation.command, invocation.args, spawnOptions);
        const session = {
            id: createTerminalSessionId(),
            originalCommand: String(command || ''),
            cwd: spawnOptions.cwd || '',
            child,
            osInfo,
            pid: child.pid,
            output: '',
            chunks: [],
            seq: 0,
            closed: false,
            exitCode: null,
            signal: null,
            startedAt: new Date().toISOString(),
            closedAt: null
        };

        interactiveTerminalSessions.set(session.id, session);

        child.stdout.on('data', (chunk) => appendInteractiveOutput(session, 'stdout', chunk));
        child.stderr.on('data', (chunk) => appendInteractiveOutput(session, 'stderr', chunk));
        child.on('error', (error) => {
            appendInteractiveOutput(session, 'stderr', error.message || 'Failed to start interactive command');
            session.closed = true;
            session.exitCode = -1;
            session.closedAt = new Date().toISOString();
        });
        child.on('close', (code, signal) => {
            session.closed = true;
            session.exitCode = Number.isInteger(code) ? code : null;
            session.signal = signal || null;
            session.closedAt = new Date().toISOString();
            setTimeout(() => {
                const current = interactiveTerminalSessions.get(session.id);
                if (current && current.closed) {
                    interactiveTerminalSessions.delete(session.id);
                }
            }, 10 * 60 * 1000);
        });

        const waitMs = Math.max(0, Math.min(Number(options.waitMs ?? DEFAULT_INTERACTIVE_WAIT_MS), 15000));
        if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        return getInteractiveSnapshot(session, options);
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

async function writeInteractiveTerminal(sessionId, input, options = {}) {
    const session = interactiveTerminalSessions.get(String(sessionId || ''));
    if (!session) return { success: false, error: 'Terminal session not found' };
    if (session.closed) {
        return { ...getInteractiveSnapshot(session, options), success: false, error: 'Terminal session has already exited' };
    }

    try {
        const text = String(input ?? '');
        session.child.stdin.write(text);
        const waitMs = Math.max(0, Math.min(Number(options.waitMs ?? DEFAULT_INTERACTIVE_WAIT_MS), 15000));
        if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        return getInteractiveSnapshot(session, options);
    } catch (error) {
        return { ...getInteractiveSnapshot(session, options), success: false, error: error.message || String(error) };
    }
}

async function readInteractiveTerminal(sessionId, options = {}) {
    const session = interactiveTerminalSessions.get(String(sessionId || ''));
    if (!session) return { success: false, error: 'Terminal session not found' };
    const waitMs = Math.max(0, Math.min(Number(options.waitMs || 0), 15000));
    if (waitMs > 0 && !session.closed) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return getInteractiveSnapshot(session, options);
}

async function stopInteractiveTerminal(sessionId, options = {}) {
    const session = interactiveTerminalSessions.get(String(sessionId || ''));
    if (!session) return { success: false, error: 'Terminal session not found' };

    if (!session.closed) {
        if (options.inputBeforeStop) {
            try {
                session.child.stdin.write(String(options.inputBeforeStop));
            } catch (_error) {
            }
        }
        await stopProcessTree(session.child, session.osInfo);
        const waitMs = Math.max(100, Math.min(Number(options.waitMs || 1000), 5000));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const snapshot = getInteractiveSnapshot(session, options);
    if (session.closed || options.forget !== false) {
        interactiveTerminalSessions.delete(session.id);
    }
    return snapshot;
}

function truncateChunk(chunk, remainingBytes) {
    if (remainingBytes <= 0) return '';
    const text = String(chunk || '');
    if (Buffer.byteLength(text, 'utf8') <= remainingBytes) return text;
    return Buffer.from(text, 'utf8').subarray(0, remainingBytes).toString('utf8');
}

function executeShellCommand(command, cwd, options = {}) {
    return new Promise((resolve) => {
        try {
            const osInfo = getOSInfo();
            const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS));
            const invocation = buildShellInvocation(command, osInfo);
            const spawnOptions = {
                cwd: (cwd && fs.existsSync(cwd)) ? cwd : undefined,
                windowsHide: true,
                env: process.env
            };

            const child = spawn(invocation.command, invocation.args, spawnOptions);
            let stdout = '';
            let stderr = '';
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let finished = false;
            let timeoutId = null;

            const finish = (payload) => {
                if (finished) return;
                finished = true;
                if (timeoutId) clearTimeout(timeoutId);
                resolve(payload);
            };

            timeoutId = setTimeout(() => {
                try {
                    child.kill();
                } catch (_error) {
                }
                finish({
                    code: -1,
                    stdout: stdout.trim(),
                    stderr: (stderr || `Command execution timed out after ${Math.round(timeoutMs / 1000)} seconds`).trim()
                });
            }, timeoutMs);

            child.stdout.on('data', (chunk) => {
                const next = truncateChunk(chunk, MAX_COMMAND_OUTPUT_BYTES - stdoutBytes);
                stdout += next;
                stdoutBytes += Buffer.byteLength(next, 'utf8');
            });

            child.stderr.on('data', (chunk) => {
                const next = truncateChunk(chunk, MAX_COMMAND_OUTPUT_BYTES - stderrBytes);
                stderr += next;
                stderrBytes += Buffer.byteLength(next, 'utf8');
            });

            child.on('error', (error) => {
                finish({
                    code: -1,
                    stdout: stdout.trim(),
                    stderr: (stderr || error.message || 'Failed to start command').trim()
                });
            });

            child.on('close', (code) => {
                finish({
                    code: Number.isInteger(code) ? code : 1,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
            });
        } catch (error) {
            resolve({ code: -1, stdout: '', stderr: error.message });
        }
    });
}

function registerCommandIPC() {
    ipcMain.handle('get-os-info', async () => {
        const info = getOSInfo();
        return {
            platform: info.platform,
            shell: info.shell,
            isWindows: info.isWindows,
            isLinux: info.isLinux,
            isMac: info.isMac,
            arch: os.arch(),
            hostname: os.hostname(),
            homedir: os.homedir(),
            tmpdir: os.tmpdir(),
            pathSep: path.sep
        };
    });

    ipcMain.handle('run-command', async (_event, command, cwd, options = {}) => {
        return await executeShellCommand(command, cwd, options);
    });

    ipcMain.handle('terminal-start', async (_event, command, cwd, options = {}) => {
        return await startInteractiveTerminal(command, cwd, options);
    });

    ipcMain.handle('terminal-write', async (_event, sessionId, input, options = {}) => {
        return await writeInteractiveTerminal(sessionId, input, options);
    });

    ipcMain.handle('terminal-read', async (_event, sessionId, options = {}) => {
        return await readInteractiveTerminal(sessionId, options);
    });

    ipcMain.handle('terminal-stop', async (_event, sessionId, options = {}) => {
        return await stopInteractiveTerminal(sessionId, options);
    });

    ipcMain.handle('open-project-terminal', async (_event, workspacePath, options = {}) => {
        return openProjectTerminal(workspacePath, options);
    });
}

module.exports = { registerCommandIPC, getOSInfo };
