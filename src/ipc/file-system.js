/**
 * IPC Handlers — File System Operations
 *
 * Handles: save-file, read-file, read-directory (recursive),
 * read-directory-shallow, search-in-files.
 */
const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const readline = require('node:readline');

/* ------------------------------------------------------------------ */
/*  Constants  @@                                                         */
/* ------------------------------------------------------------------ */


const IGNORED_DIRS = [
    'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
    '.next', 'coverage', '.vscode', '.idea', 'vendor', 'target',
    '.turbo', '.cache', '.parcel-cache', '.svelte-kit', '.angular',
    '.venv', 'venv', '__pycache__'
];

const CODE_EXTENSIONS = [
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs',
    '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.html',
    '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.json',
    '.xml', '.yaml', '.yml', '.md', '.txt', '.sql', '.sh', '.bat', '.ps1'
];

const BINARY_EXTENSIONS = [
    '.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif',
    '.ico', '.zip', '.tar', '.gz', '.pdf', '.webp',
    '.mp4', '.mov', '.avi', '.mp3', '.wav', '.woff', '.woff2'
];

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024 * 5;
const MAX_DIRECTORY_FILES = 12000;
const MAX_SEARCH_FILES_SCANNED = 30000;
const SMART_READ_FULL_BYTES = 180 * 1024;
const SMART_READ_HEAD_BYTES = 48 * 1024;
const SMART_READ_TAIL_BYTES = 24 * 1024;
const SMART_READ_MAX_LINES = 260;
const SMART_READ_MAX_CHARS = 42000;
const LOW_VALUE_SEARCH_FILE_RE = /(?:\.min\.js|\.map)$/i;
const IGNORED_DIR_SET = new Set(IGNORED_DIRS.map((name) => name.toLowerCase()));
const WORKSPACE_ROOT_FILES = new Set([
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-workspace.yml',
    'turbo.json',
    'nx.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    '.git',
    '.hg',
    '.svn'
]);
const WORKSPACE_ROOT_SUFFIXES = ['.sln', '.code-workspace'];

function normalizeSearchQuery(query) {
    let q = String(query ?? '').replace(/\r\n/g, '\n').trim();
    if (q.length >= 2 && ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'")))) {
        q = q.slice(1, -1);
    }
    return q;
}

function getPreviewAroundLine(lines, lineIndex, padding = 1) {
    const start = Math.max(0, lineIndex - padding);
    const end = Math.min(lines.length, lineIndex + padding + 1);
    return lines.slice(start, end).join('\n').trim();
}

function findMultilineMatches(content, query, maxMatches = MAX_SEARCH_RESULTS) {
    const matches = [];
    if (!content || !query) return matches;

    const normalizedContent = String(content).replace(/\r\n/g, '\n');
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return matches;

    let searchStart = 0;
    while (matches.length < maxMatches) {
        const matchIndex = normalizedContent.indexOf(normalizedQuery, searchStart);
        if (matchIndex === -1) break;

        const beforeMatch = normalizedContent.slice(0, matchIndex);
        const startLine = beforeMatch.split('\n').length;
        const queryLineCount = normalizedQuery.split('\n').length;
        const endLine = startLine + queryLineCount - 1;
        const contentLines = normalizedContent.split('\n');
        const preview = contentLines
            .slice(Math.max(0, startLine - 2), Math.min(contentLines.length, endLine + 1))
            .join('\n')
            .trim();

        matches.push({
            line: startLine,
            endLine,
            content: preview
        });

        searchStart = matchIndex + Math.max(normalizedQuery.length, 1);
    }

    return matches;
}

async function directoryContainsWorkspaceMarker(dirPath) {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (WORKSPACE_ROOT_FILES.has(entry.name)) return true;
            if (WORKSPACE_ROOT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return true;
        }
    } catch (_error) {
    }

    return false;
}

async function findWorkspaceRoot(filePath) {
    const absolutePath = path.resolve(String(filePath || ''));
    if (!absolutePath) {
        throw new Error('File path is required');
    }

    let stat = null;
    try {
        stat = await fs.promises.stat(absolutePath);
    } catch (_error) {
    }

    let currentDir = stat && stat.isDirectory()
        ? absolutePath
        : path.dirname(absolutePath);
    const fallbackDir = currentDir;

    while (currentDir) {
        if (await directoryContainsWorkspaceMarker(currentDir)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (!parentDir || parentDir === currentDir) break;
        currentDir = parentDir;
    }

    return fallbackDir;
}

function execFileAsync(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
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

async function validateCodeSyntax(extension, code) {
    const normalizedExtension = String(extension || '').toLowerCase().replace(/^\./, '');
    const source = String(code ?? '');

    if (!normalizedExtension) {
        return { success: true, skipped: true };
    }

    if (normalizedExtension === 'json') {
        try {
            JSON.parse(source);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    if (!['js', 'mjs', 'cjs'].includes(normalizedExtension)) {
        return { success: true, skipped: true };
    }

    const tempFile = path.join(
        os.tmpdir(),
        `ghostli-validate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.${normalizedExtension}`
    );

    try {
        await fs.promises.writeFile(tempFile, source, 'utf8');
        await execFileAsync(process.execPath, ['--check', tempFile]);
        return { success: true };
    } catch (error) {
        const details = String(error.stderr || error.stdout || error.message || 'Unknown syntax error').trim();
        return { success: false, error: details };
    } finally {
        try {
            await fs.promises.unlink(tempFile);
        } catch (_error) {
        }
    }
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

async function readFileLineWindow(filePath, options = {}) {
    const aroundLine = Math.max(0, Number(options.aroundLine || 0));
    const maxLines = Math.max(1, Math.min(Number(options.maxLines || SMART_READ_MAX_LINES), SMART_READ_MAX_LINES));
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
    let truncated = false;
    let charCount = 0;

    try {
        for await (const line of rl) {
            lineNumber++;
            if (lineNumber < startLine) continue;
            if (lineNumber > endLine) break;

            lines.push(line);
            charCount += line.length + 1;
            if (charCount >= SMART_READ_MAX_CHARS) {
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

async function smartReadTextFile(filePath, options = {}) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (BINARY_EXTENSIONS.includes(ext)) {
        return { success: false, error: 'Binary file cannot be read as text' };
    }

    const stat = await fs.promises.stat(filePath);
    const wantsRangeRead = Number(options.startLine || 0) > 0
        || Number(options.endLine || 0) > 0
        || Number(options.aroundLine || 0) > 0;

    if (wantsRangeRead) {
        const rangeResult = await readFileLineWindow(filePath, options);
        return {
            ...rangeResult,
            bytes: stat.size
        };
    }

    const preferFull = options.preferFull === true || options.full === true;
    if (stat.size <= SMART_READ_FULL_BYTES && !options.overviewOnly) {
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

    if (preferFull && stat.size <= SMART_READ_FULL_BYTES * 2) {
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

    const head = await readPartialBytes(filePath, 0, Math.min(SMART_READ_HEAD_BYTES, stat.size));
    const tail = stat.size > SMART_READ_HEAD_BYTES
        ? await readPartialBytes(filePath, Math.max(0, stat.size - SMART_READ_TAIL_BYTES), Math.min(SMART_READ_TAIL_BYTES, stat.size))
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
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Recursively collects code files from a directory tree.
 * @param {string} dir      — absolute path to scan
 * @param {string} basePath — relative prefix for output paths
 * @returns {Array<{name:string, path:string, relativePath:string, extension:string}>}
 */
async function readDirRecursive(dir, basePath = '', state = { count: 0 }) {
    const items = [];
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (state.count >= MAX_DIRECTORY_FILES) break;
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.join(basePath, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORED_DIR_SET.has(entry.name.toLowerCase())) {
                    // Prevent crazy depths
                    if (basePath.split(path.sep).length > 15) continue;
                    const subItems = await readDirRecursive(fullPath, relativePath, state);
                    items.push(...subItems);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (CODE_EXTENSIONS.includes(ext)) {
                    let size = 0;
                    try {
                        size = (await fs.promises.stat(fullPath)).size;
                    } catch (_error) {
                    }
                    items.push({ name: entry.name, path: fullPath, relativePath, extension: ext, size });
                    state.count++;
                }
            }
        }
    } catch (err) {
        // Ignore unreadable directories
    }
    return items;
}

/**
 * Recursively searches file contents for a query string.
 * @param {string}        rootPath   — directory to search
 * @param {string}        query      — text to find
 * @param {string[]|null} extensions — optional whitelist (without dots)
 * @returns {Array<{file:string, line:number, content:string}>}
 */
async function searchInFiles(rootPath, query, extensions = null) {
    const results = [];
    let count = 0;
    let scannedFiles = 0;
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
        return results;
    }

    const wantsMultilineSearch = normalizedQuery.includes('\n');

    const walk = async (dir) => {
        if (count >= MAX_SEARCH_RESULTS || scannedFiles >= MAX_SEARCH_FILES_SCANNED) return;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (count >= MAX_SEARCH_RESULTS || scannedFiles >= MAX_SEARCH_FILES_SCANNED) return;
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (IGNORED_DIR_SET.has(entry.name.toLowerCase())) continue;
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    if (LOW_VALUE_SEARCH_FILE_RE.test(entry.name)) continue;
                    // Extension filter
                    if (extensions && extensions.length > 0) {
                        const ext = path.extname(entry.name).toLowerCase().replace('.', '');
                        if (!extensions.includes(ext)) continue;
                    } else {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (BINARY_EXTENSIONS.includes(ext)) continue;
                    }

                    try {
                        scannedFiles++;
                        const stats = await fs.promises.stat(fullPath);
                        if (stats.size > MAX_SEARCH_FILE_BYTES) continue;

                        const content = await fs.promises.readFile(fullPath, 'utf8');
                        const relativeFile = path.relative(rootPath, fullPath) || entry.name;

                        if (wantsMultilineSearch) {
                            const matches = findMultilineMatches(content, normalizedQuery, MAX_SEARCH_RESULTS - count);
                            for (const match of matches) {
                                results.push({
                                    file: fullPath,
                                    relativeFile,
                                    line: match.line,
                                    endLine: match.endLine,
                                    content: match.content
                                });
                                count++;
                                if (count >= MAX_SEARCH_RESULTS) break;
                            }
                            continue;
                        }

                        const lines = content.split(/\r?\n/);
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].includes(normalizedQuery)) {
                                results.push({
                                    file: fullPath,
                                    relativeFile,
                                    line: i + 1,
                                    content: getPreviewAroundLine(lines, i)
                                });
                                count++;
                                if (count >= MAX_SEARCH_RESULTS) break;
                            }
                        }
                    } catch {
                        // skip unreadable files
                    }
                }
            }
        } catch (err) {
            // Ignore unreadable directories
        }
    };

    if (fs.existsSync(rootPath)) await walk(rootPath);
    return results;
}

/* ------------------------------------------------------------------ */
/*  IPC Registration                                                   */
/* ------------------------------------------------------------------ */

function registerFileSystemIPC() {
   
    ipcMain.handle('save-file', async (_event, filePath, content) => {
        try {
            fs.writeFileSync(filePath, content, 'utf8');
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

 
    ipcMain.handle('read-file', async (_event, filePath) => {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return { success: true, content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('read-file-smart', async (_event, filePath, options = {}) => {
        try {
            return await smartReadTextFile(filePath, options);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

   
    ipcMain.handle('read-directory', async (_event, dirPath) => {
        try {
            const state = { count: 0 };
            const files = await readDirRecursive(dirPath, '', state);
            return { success: true, files, truncated: state.count >= MAX_DIRECTORY_FILES, maxFiles: MAX_DIRECTORY_FILES };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

   
    ipcMain.handle('read-directory-shallow', async (_event, dirPath) => {
        try {
            if (!fs.existsSync(dirPath)) {
                return { success: false, error: 'Directory does not exist' };
            }

            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const files = entries.map((entry) => {
                const stats = fs.statSync(path.join(dirPath, entry.name));
                return {
                    name: entry.name,
                    isDirectory: entry.isDirectory(),
                    size: stats.size,
                    mtime: stats.mtime
                };
            });

        
            files.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, files };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

  
    ipcMain.handle('search-in-files', async (_event, rootPath, query, extensions = null) => {
        try {
            const results = await searchInFiles(rootPath, query, extensions);
            return { success: true, results };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('find-workspace-root', async (_event, filePath) => {
        try {
            const rootPath = await findWorkspaceRoot(filePath);
            const absolutePath = path.resolve(String(filePath || ''));
            return {
                success: true,
                rootPath,
                relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, '/')
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('validate-code-syntax', async (_event, extension, code) => {
        try {
            return await validateCodeSyntax(extension, code);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerFileSystemIPC };
