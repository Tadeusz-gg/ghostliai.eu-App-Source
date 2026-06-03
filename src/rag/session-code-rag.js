(function (global) {
  'use strict';

  const MAX_DOCS = 80;
  const MAX_CHUNKS = 260;
  const MAX_TOTAL_CHARS = 220000;
  const MAX_CHARS_PER_DOC = 18000;
  const MAX_CHARS_PER_CHUNK = 1600;
  const CHUNK_OVERLAP_LINES = 8;
  const MAX_PINNED_PATHS = 10;
  const MAX_CATALOG_PATHS = 240;
  const MAX_SEARCH_MEMORIES = 80;

  function nowIso() {
    return new Date().toISOString();
  }

  function estimateTokens(text) {
    return Math.max(0, Math.ceil(String(text || '').length / 4));
  }

  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').trim();
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .match(/[a-z0-9_.$/-]{2,}/g) || [];
  }

  function unique(items) {
    return Array.from(new Set(items.filter(Boolean)));
  }

  function createState(seed) {
    const base = {
      version: 1,
      updatedAt: nowIso(),
      documents: [],
      pinnedPaths: [],
      catalogPaths: [],
      searchMemories: []
    };

    if (!seed || typeof seed !== 'object') {
      return base;
    }

    return {
      version: 1,
      updatedAt: String(seed.updatedAt || nowIso()),
      documents: Array.isArray(seed.documents) ? seed.documents.map(hydrateDocument).filter(Boolean) : [],
      pinnedPaths: Array.isArray(seed.pinnedPaths) ? unique(seed.pinnedPaths.map(normalizePath)).slice(-MAX_PINNED_PATHS) : [],
      catalogPaths: Array.isArray(seed.catalogPaths) ? unique(seed.catalogPaths.map(normalizePath)).slice(-MAX_CATALOG_PATHS) : [],
      searchMemories: Array.isArray(seed.searchMemories) ? seed.searchMemories.slice(-MAX_SEARCH_MEMORIES) : []
    };
  }

  function hydrateDocument(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const path = normalizePath(doc.path);
    const key = String(doc.key || path || '');
    if (!key) return null;
    return {
      key,
      path,
      label: String(doc.label || path || key),
      kind: String(doc.kind || 'file'),
      readMode: String(doc.readMode || 'partial'),
      totalChars: Number(doc.totalChars || 0),
      totalLines: Number(doc.totalLines || 0),
      summary: String(doc.summary || ''),
      outline: String(doc.outline || ''),
      updatedAt: String(doc.updatedAt || nowIso()),
      accessCount: Number(doc.accessCount || 0),
      pinned: !!doc.pinned,
      sourceQuery: String(doc.sourceQuery || ''),
      chunks: Array.isArray(doc.chunks) ? doc.chunks.map((chunk, index) => hydrateChunk(chunk, key, index)).filter(Boolean) : []
    };
  }

  function hydrateChunk(chunk, docKey, index) {
    if (!chunk || typeof chunk !== 'object') return null;
    const text = String(chunk.text || '');
    if (!text) return null;
    return {
      id: String(chunk.id || `${docKey}#${index}`),
      path: normalizePath(chunk.path),
      kind: String(chunk.kind || 'file_chunk'),
      startLine: Number(chunk.startLine || 0),
      endLine: Number(chunk.endLine || 0),
      readMode: String(chunk.readMode || 'partial'),
      text,
      tokens: unique(Array.isArray(chunk.tokens) ? chunk.tokens : tokenize(text)).slice(0, 120),
      scoreHints: unique(Array.isArray(chunk.scoreHints) ? chunk.scoreHints : []),
      updatedAt: String(chunk.updatedAt || nowIso())
    };
  }

  function serializeState(state) {
    return createState(state);
  }

  function buildOutline(content) {
    const lines = String(content || '').split(/\r?\n/);
    const important = [];
    const importantLineRe = /^\s*(?:import |export |async function |function |class |interface |type |enum |const [A-Z_a-z$][\w$]*\s*=|app\.|router\.|ipcMain\.|ipcRenderer\.|module\.exports|export default)/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!importantLineRe.test(line)) continue;
      important.push(`L${i + 1}: ${line.trim()}`);
      if (important.length >= 24) break;
    }
    return important.join('\n');
  }

  function chunkContent(path, content, options) {
    const readMode = String(options?.readMode || 'partial');
    const sourceText = String(content || '').slice(0, MAX_CHARS_PER_DOC);
    const lines = sourceText.split(/\r?\n/);
    const chunks = [];
    let startLine = 1;
    let cursor = 0;

    while (cursor < lines.length) {
      let end = cursor;
      let charCount = 0;
      while (end < lines.length) {
        const nextLine = lines[end];
        if (charCount > 0 && (charCount + nextLine.length + 1) > MAX_CHARS_PER_CHUNK) break;
        charCount += nextLine.length + 1;
        end++;
      }

      const slice = lines.slice(cursor, end);
      const text = slice.join('\n').trim();
      if (text) {
        chunks.push({
          id: `${normalizePath(path)}#L${startLine}-${startLine + slice.length - 1}`,
          path: normalizePath(path),
          kind: 'file_chunk',
          startLine,
          endLine: startLine + slice.length - 1,
          readMode,
          text,
          tokens: unique(tokenize(text)).slice(0, 120),
          scoreHints: unique(tokenize(`${path} ${text.slice(0, 600)}`)).slice(0, 60),
          updatedAt: nowIso()
        });
      }

      if (end >= lines.length) break;
      const nextCursor = Math.max(cursor + 1, end - CHUNK_OVERLAP_LINES);
      startLine += (nextCursor - cursor);
      cursor = nextCursor;
    }

    return chunks;
  }

  function upsertDocument(state, document) {
    const key = String(document.key || document.path || '');
    if (!key) return;
    const index = state.documents.findIndex((entry) => entry.key === key);
    if (index === -1) state.documents.push(document);
    else state.documents[index] = document;
    state.updatedAt = nowIso();
  }

  function removeDocument(state, matcher) {
    const before = state.documents.length;
    state.documents = state.documents.filter((doc) => !matcher(doc));
    if (state.documents.length !== before) {
      state.updatedAt = nowIso();
    }
  }

  function touchPinnedPath(state, path) {
    const normalized = normalizePath(path);
    if (!normalized) return;
    state.pinnedPaths = state.pinnedPaths.filter((entry) => entry !== normalized);
    state.pinnedPaths.push(normalized);
    if (state.pinnedPaths.length > MAX_PINNED_PATHS) {
      state.pinnedPaths = state.pinnedPaths.slice(-MAX_PINNED_PATHS);
    }
  }

  function updateCatalogPaths(state, paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const merged = unique([...state.catalogPaths, ...paths.map(normalizePath)]);
    state.catalogPaths = merged.slice(-MAX_CATALOG_PATHS);
    state.updatedAt = nowIso();
  }

  function addSearchMemory(state, memory) {
    state.searchMemories.push(memory);
    if (state.searchMemories.length > MAX_SEARCH_MEMORIES) {
      state.searchMemories = state.searchMemories.slice(-MAX_SEARCH_MEMORIES);
    }
    state.updatedAt = nowIso();
  }

  function buildFileSummary(path, payload) {
    const segments = [];
    if (payload.readMode === 'overview') {
      segments.push(`Large file overview for ${path}`);
      if (payload.totalLines) segments.push(`${payload.totalLines} lines`);
      if (payload.totalChars) segments.push(`${Math.round(payload.totalChars / 1024)}KB`);
    } else if (payload.truncated) {
      segments.push(`Partial read for ${path}`);
    } else {
      segments.push(`File memory for ${path}`);
    }

    if (payload.warning) segments.push(String(payload.warning));
    return segments.join(' | ');
  }

  function ingestReadResult(state, result) {
    const path = normalizePath(result?.path);
    const content = String(result?.content || '');
    if (!path || !content) return;

    const payload = {
      key: `file:${path}`,
      path,
      label: path,
      kind: 'file',
      readMode: String(result?.readMode || (result?.truncated ? 'partial' : 'full')),
      totalChars: Number(result?.totalChars || content.length),
      totalLines: Number(result?.totalLines || content.split(/\r?\n/).length),
      summary: buildFileSummary(path, { ...result, content }),
      outline: buildOutline(content),
      updatedAt: nowIso(),
      accessCount: Number((state.documents.find((doc) => doc.key === `file:${path}`)?.accessCount || 0) + 1),
      pinned: state.pinnedPaths.includes(path),
      sourceQuery: '',
      chunks: chunkContent(path, content, { readMode: result?.readMode || 'partial' })
    };

    upsertDocument(state, payload);
    touchPinnedPath(state, path);
  }

  function ingestSearchResult(state, result) {
    const query = String(result?.query || '').trim();
    const matches = Array.isArray(result?.results) ? result.results.slice(0, 24) : [];
    if (!query || matches.length === 0) return;

    const chunks = matches
      .map((match, index) => {
        const path = normalizePath(match.relativeFile || match.file || '');
        const text = String(match.content || '').trim();
        if (!path || !text) return null;
        return {
          id: `search:${query}:${index}`,
          path,
          kind: 'search_hit',
          startLine: Number(match.line || 0),
          endLine: Number(match.endLine || match.line || 0),
          readMode: 'snippet',
          text,
          tokens: unique(tokenize(`${path} ${text}`)).slice(0, 90),
          scoreHints: unique(tokenize(`${query} ${path}`)).slice(0, 60),
          updatedAt: nowIso()
        };
      })
      .filter(Boolean);

    if (!chunks.length) return;

    addSearchMemory(state, {
      query,
      updatedAt: nowIso(),
      hits: chunks.map((chunk) => ({
        path: chunk.path,
        line: chunk.startLine,
        snippet: chunk.text.slice(0, 240)
      })).slice(0, 8)
    });

    upsertDocument(state, {
      key: `search:${query}`,
      path: '',
      label: `Search: ${query}`,
      kind: 'search',
      readMode: 'snippet',
      totalChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      totalLines: chunks.length,
      summary: `Search memory for "${query}"`,
      outline: '',
      updatedAt: nowIso(),
      accessCount: Number((state.documents.find((doc) => doc.key === `search:${query}`)?.accessCount || 0) + 1),
      pinned: false,
      sourceQuery: query,
      chunks
    });
  }

  function ingestDirectoryResult(state, result) {
    const files = Array.isArray(result?.files) ? result.files : [];
    const paths = files
      .map((file) => normalizePath(file.relativePath || file.path || file.name || ''))
      .filter(Boolean)
      .slice(0, 300);
    updateCatalogPaths(state, paths);
  }

  function noteMutation(state, result, readCache) {
    const path = normalizePath(result?.path || result?.from || '');
    if (!path) return;

    if (result?.type === 'delete_path') {
      removeDocument(state, (doc) => doc.path === path);
      state.catalogPaths = state.catalogPaths.filter((entry) => entry !== path && !entry.startsWith(path + '/'));
      return;
    }

    if (result?.type === 'rename_path') {
      const toPath = normalizePath(result?.to);
      if (!toPath) return;
      const doc = state.documents.find((entry) => entry.path === path);
      if (doc) {
        doc.path = toPath;
        doc.label = toPath;
        doc.key = doc.kind === 'file' ? `file:${toPath}` : doc.key;
        doc.chunks = (doc.chunks || []).map((chunk) => ({
          ...chunk,
          path: toPath,
          id: `${toPath}#L${chunk.startLine || 0}-${chunk.endLine || 0}`
        }));
      }
      state.catalogPaths = state.catalogPaths.map((entry) => {
        if (entry === path) return toPath;
        if (entry.startsWith(path + '/')) return toPath + entry.slice(path.length);
        return entry;
      });
      touchPinnedPath(state, toPath);
      return;
    }

    if (readCache && typeof readCache.get === 'function' && readCache.has(path)) {
      ingestReadResult(state, {
        type: 'read_file',
        path,
        content: String(readCache.get(path) || ''),
        readMode: 'full'
      });
      return;
    }

    touchPinnedPath(state, path);
  }

  function pruneState(state) {
    const isPinned = (doc) => doc.pinned || state.pinnedPaths.includes(doc.path);

    const computeStats = () => {
      const allChunks = state.documents.flatMap((doc) => doc.chunks || []);
      const totalChars = allChunks.reduce((sum, chunk) => sum + String(chunk.text || '').length, 0);
      return {
        docCount: state.documents.length,
        chunkCount: allChunks.length,
        totalChars
      };
    };

    let stats = computeStats();
    if (stats.docCount <= MAX_DOCS && stats.chunkCount <= MAX_CHUNKS && stats.totalChars <= MAX_TOTAL_CHARS) {
      return stats;
    }

    state.documents.sort((a, b) => {
      const aPinned = isPinned(a) ? 1 : 0;
      const bPinned = isPinned(b) ? 1 : 0;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
    });

    while (state.documents.length > 1) {
      stats = computeStats();
      if (stats.docCount <= MAX_DOCS && stats.chunkCount <= MAX_CHUNKS && stats.totalChars <= MAX_TOTAL_CHARS) break;
      const removableIndex = state.documents.findIndex((doc) => !isPinned(doc));
      if (removableIndex === -1) break;
      state.documents.splice(removableIndex, 1);
    }

    return computeStats();
  }

  function ingestActionResults(stateInput, results, options) {
    const state = createState(stateInput);
    const readCache = options?.readCache;

    (results || []).forEach((result) => {
      if (!result || !result.ok) return;
      if (result.type === 'read_file') ingestReadResult(state, result);
      else if (result.type === 'search_files') ingestSearchResult(state, result);
      else if (result.type === 'read_directory') ingestDirectoryResult(state, result);
      else if (['write_file', 'apply_patch', 'delete_path', 'rename_path'].includes(result.type)) noteMutation(state, result, readCache);
    });

    pruneState(state);
    return state;
  }

  function scoreChunk(chunk, queryTokens, objectiveTokens) {
    const chunkTokens = Array.isArray(chunk.tokens) ? chunk.tokens : [];
    const hintTokens = Array.isArray(chunk.scoreHints) ? chunk.scoreHints : [];
    let score = 0;

    queryTokens.forEach((token) => {
      if (chunkTokens.includes(token)) score += 9;
      if (hintTokens.includes(token)) score += 5;
      if (chunk.path && chunk.path.toLowerCase().includes(token)) score += 12;
    });

    objectiveTokens.forEach((token) => {
      if (chunkTokens.includes(token)) score += 3;
      if (chunk.path && chunk.path.toLowerCase().includes(token)) score += 4;
    });

    if (chunk.kind === 'search_hit') score += 6;
    if (chunk.readMode === 'full') score += 2;
    if (chunk.readMode === 'overview') score -= 1;
    if (chunk.startLine > 0) score += 1;

    return score;
  }

  function retrieve(stateInput, query, options) {
    const state = createState(stateInput);
    const queryTokens = unique(tokenize(query)).slice(0, 40);
    const objectiveTokens = unique(tokenize(options?.objective || '')).slice(0, 30);
    const allChunks = state.documents.flatMap((doc) => doc.chunks || []);
    const scored = allChunks
      .map((chunk) => ({
        ...chunk,
        _score: scoreChunk(chunk, queryTokens, objectiveTokens)
      }))
      .filter((chunk) => chunk._score > 0)
      .sort((a, b) => b._score - a._score);

    const maxChars = Number(options?.maxChars || 9000);
    const selected = [];
    const seen = new Set();
    let usedChars = 0;

    for (const chunk of scored) {
      if (seen.has(chunk.id)) continue;
      const textLen = String(chunk.text || '').length;
      if (textLen === 0) continue;
      if (selected.length >= 8) break;
      if (usedChars > 0 && (usedChars + textLen) > maxChars) continue;
      selected.push(chunk);
      seen.add(chunk.id);
      usedChars += textLen;
    }

    return {
      state,
      chunks: selected,
      stats: {
        documents: state.documents.length,
        chunks: allChunks.length,
        totalChars: allChunks.reduce((sum, chunk) => sum + String(chunk.text || '').length, 0),
        catalogPaths: state.catalogPaths.length,
        searchMemories: state.searchMemories.length
      }
    };
  }

  function formatContextForPrompt(stateInput, query, options) {
    const retrieval = retrieve(stateInput, query, options);
    const state = retrieval.state;
    const chunks = retrieval.chunks;
    if (!chunks.length && !state.catalogPaths.length && !state.searchMemories.length) {
      return '';
    }

    const lines = [];
    lines.push('[SESSION CODE RAG]');
    lines.push(`Cached docs: ${retrieval.stats.documents}, cached chunks: ${retrieval.stats.chunks}, file catalog: ${retrieval.stats.catalogPaths}`);

    if (state.catalogPaths.length > 0) {
      const catalogPreview = state.catalogPaths.slice(0, 24).join(', ');
      lines.push(`Known paths: ${catalogPreview}${state.catalogPaths.length > 24 ? ', ...' : ''}`);
    }

    if (state.searchMemories.length > 0) {
      const recentSearches = state.searchMemories
        .slice(-3)
        .map((memory) => `"${memory.query}"`)
        .join(', ');
      lines.push(`Recent searches: ${recentSearches}`);
    }

    chunks.forEach((chunk, index) => {
      const lineInfo = chunk.startLine && chunk.endLine
        ? ` [lines ${chunk.startLine}-${chunk.endLine}]`
        : '';
      lines.push(`Source ${index + 1}: ${chunk.path || chunk.kind}${lineInfo}`);
      lines.push('```text');
      lines.push(String(chunk.text || '').trim());
      lines.push('```');
    });

    lines.push('[END SESSION CODE RAG]');
    return lines.join('\n');
  }

  global.SessionCodeRAG = {
    createState,
    serializeState,
    ingestActionResults,
    formatContextForPrompt,
    retrieve,
    estimateTokens
  };
})(typeof window !== 'undefined' ? window : global);
