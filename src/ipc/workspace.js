/**
 * IPC Handlers — Workspace Operations
 *
 * Provides sandboxed file I/O scoped to a workspace root.
 * All paths are validated to prevent directory traversal attacks.
 *
 * Handles: workspace-read-file, workspace-write-file,
 *          workspace-delete-path, workspace-mkdir,
 *          workspace-rename-path, workspace-stat
 */
const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const readline = require('node:readline');

const WORKSPACE_SMART_READ_FULL_BYTES = 180 * 1024;
const WORKSPACE_SMART_READ_HEAD_BYTES = 48 * 1024;
const WORKSPACE_SMART_READ_TAIL_BYTES = 24 * 1024;
const WORKSPACE_SMART_READ_MAX_LINES = 260;
const WORKSPACE_SMART_READ_MAX_CHARS = 42000;

/* ------------------------------------------------------------------ */
/*  Path Security                                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolves a relative path within a workspace root.
 * Throws if the resolved path escapes the root (path traversal).
 *
 * @param {string} workspaceRoot — absolute path to workspace
 * @param {string} relativePath  — path relative to root
 * @returns {string} absolute resolved path
 * @throws {Error} if resolved path is outside workspace root
 */
function resolveWorkspacePath(workspaceRoot, relativePath) {
    const root = path.resolve(String(workspaceRoot || ''));
    const resolved = path.resolve(root, String(relativePath || ''));
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        throw new Error('Path is outside workspace root');
    }

    return resolved;
}

async function readPartialBytes(filePath, start, length) {
    const safeLength = Math.max(0, Math.floor(Number(length || 0)));
    if (safeLength === 0) return '';

    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(safeLength);
        const { bytesRead } = await handle.read(buffer, 0, safeLength, Math.max(0, Math.floor(Number(start || 0))));
        return buffer.slice(0, bytesRead).toString('utf8');
    } finally {
        try {
            await handle.close();
        } catch (_error) {
        }
    }
}

async function readWorkspaceLineWindow(filePath, options = {}) {
    const aroundLine = Math.max(0, Number(options.aroundLine || 0));
    const maxLines = Math.max(1, Math.min(Number(options.maxLines || WORKSPACE_SMART_READ_MAX_LINES), WORKSPACE_SMART_READ_MAX_LINES));
    let startLine = Math.max(1, Number(options.startLine || 0));
    let endLine = Math.max(0, Number(options.endLine || 0));

    if (aroundLine > 0) {
        const halfWindow = Math.floor(maxLines / 2);
        startLine = Math.max(1, aroundLine - halfWindow);
        endLine = aroundLine + halfWindow;
    } else {
        if (startLine <= 0) startLine = 1;
        if (endLine <= 0) endLine = startLine + maxLines - 1;
        if ((endLine - startLine + 1) > maxLines) {
            endLine = startLine + maxLines - 1;
        }
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    let lineNumber = 0;
    let charCount = 0;
    let truncated = false;

    try {
        for await (const line of rl) {
            lineNumber++;
            if (lineNumber < startLine) continue;
            if (lineNumber > endLine) break;

            lines.push(line);
            charCount += line.length + 1;
            if (charCount >= WORKSPACE_SMART_READ_MAX_CHARS) {
                truncated = true;
                break;
            }
        }
    } finally {
        rl.close();
        stream.destroy();
    }

    const content = lines.join('\n');
    return {
        success: true,
        content,
        readMode: 'range',
        startLine,
        endLine: lines.length ? (startLine + lines.length - 1) : startLine,
        truncated,
        totalChars: content.length,
        totalLines: lines.length,
        warning: truncated
            ? 'Requested range was trimmed to stay within the live context budget.'
            : null
    };
}

async function workspaceSmartReadFile(filePath, options = {}) {
    const stat = await fs.promises.stat(filePath);
    const wantsRangeRead = Number(options.startLine || 0) > 0
        || Number(options.endLine || 0) > 0
        || Number(options.aroundLine || 0) > 0;

    if (wantsRangeRead) {
        const rangeResult = await readWorkspaceLineWindow(filePath, options);
        return {
            ...rangeResult,
            bytes: stat.size
        };
    }

    const preferFull = options.preferFull === true || options.full === true;
    if (stat.size <= WORKSPACE_SMART_READ_FULL_BYTES) {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return {
            success: true,
            content,
            readMode: 'full',
            truncated: false,
            totalChars: content.length,
            totalLines: content.split(/\r?\n/).length,
            bytes: stat.size
        };
    }

    if (preferFull && stat.size <= WORKSPACE_SMART_READ_FULL_BYTES * 2) {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return {
            success: true,
            content,
            readMode: 'full',
            truncated: false,
            totalChars: content.length,
            totalLines: content.split(/\r?\n/).length,
            bytes: stat.size
        };
    }

    const head = await readPartialBytes(filePath, 0, Math.min(WORKSPACE_SMART_READ_HEAD_BYTES, stat.size));
    const tail = stat.size > WORKSPACE_SMART_READ_HEAD_BYTES
        ? await readPartialBytes(filePath, Math.max(0, stat.size - WORKSPACE_SMART_READ_TAIL_BYTES), Math.min(WORKSPACE_SMART_READ_TAIL_BYTES, stat.size))
        : '';
    const parts = [];
    if (head.trim()) parts.push(head.trimEnd());
    if (tail.trim()) {
        parts.push(`/* ... large file omitted for stability (${Math.round(stat.size / 1024)}KB) ... */`);
        parts.push(tail.trimStart());
    }

    return {
        success: true,
        content: parts.join('\n\n'),
        readMode: 'overview',
        truncated: true,
        totalChars: stat.size,
        totalLines: 0,
        bytes: stat.size,
        warning: 'Large file returned as overview. Use search_files first, then read_file with aroundLine/startLine/endLine for exact edits.'
    };
}

/* ------------------------------------------------------------------ */
/*  IPC Registration                                                   */
/* ------------------------------------------------------------------ */

function registerWorkspaceIPC() {
    ipcMain.handle('workspace-read-file', async (_event, workspaceRoot, relativePath) => {
        try {
            const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            return { success: true, content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-read-file-smart', async (_event, workspaceRoot, relativePath, options = {}) => {
        try {
            const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            return await workspaceSmartReadFile(fullPath, options);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-write-file', async (_event, workspaceRoot, relativePath, content) => {
        try {
            const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, String(content ?? ''), 'utf8');
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-delete-path', async (_event, workspaceRoot, relativePath) => {
        try {
            const root = path.resolve(String(workspaceRoot || '')); // Normalize root path
            let fullPath;

            try {
                fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            } catch (e) {
                // If path resolution fails (e.g. strict check), try flexible check if it matches root
                const naive = path.resolve(root, String(relativePath || ''));
                if (naive === root) fullPath = root;
                else throw e;
            }

            if (!fs.existsSync(fullPath)) {
                // If path looks like "some/dir/*" (wildcard was passed to IPC), strip it and retry
                if (String(relativePath).endsWith('*')) {
                    const cleanRel = String(relativePath).replace(/[*\\/]+$/, '');
                    fullPath = resolveWorkspacePath(workspaceRoot, cleanRel);
                    if (!fs.existsSync(fullPath)) return { success: false, error: 'Path does not exist' };
                } else {
                    return { success: false, error: 'Path does not exist' };
                }
            }

            // SAFETY CHECK: If deleting the ROOT workspace folder itself
            if (fullPath === root) {
                // Instead of nuking the folder (EBUSY error), clear its CONTENTS
                const files = fs.readdirSync(fullPath);
                for (const file of files) {
                    const curPath = path.join(fullPath, file);
                    // Force delete recursive
                    fs.rmSync(curPath, { recursive: true, force: true });
                }
                return { success: true };
            }

            // Normal deletion (subfolder or file)
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(fullPath);
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-mkdir', async (_event, workspaceRoot, relativePath) => {
        try {
            const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            fs.mkdirSync(fullPath, { recursive: true });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-rename-path', async (_event, workspaceRoot, fromRelPath, toRelPath) => {
        try {
            const fromPath = resolveWorkspacePath(workspaceRoot, fromRelPath);
            const toPath = resolveWorkspacePath(workspaceRoot, toRelPath);
            fs.mkdirSync(path.dirname(toPath), { recursive: true });
            fs.renameSync(fromPath, toPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('workspace-stat', async (_event, workspaceRoot, relativePath) => {
        try {
            const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
            const stat = fs.statSync(fullPath);
            return {
                success: true,
                stat: {
                    isFile: stat.isFile(),
                    isDirectory: stat.isDirectory(),
                    size: stat.size,
                    mtimeMs: stat.mtimeMs
                }
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerWorkspaceIPC };
