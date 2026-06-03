const { ipcMain, BrowserWindow } = require('electron');

/**
 * IPC Handlers _ Web Search & Page Scraping
 *
 * Hidden browser windows for search + scrape. All windows are fully silenced
 * (muted webContents, autoplay blocked, media paused) so RAG never plays audio.
 */

const MAX_PAGE_CONTENT_LENGTH = 12000;
const RAG_MAX_PAGE_CONTENT_LENGTH = 28000;
const PAGE_FETCH_TIMEOUT_MS = 8000;
const RAG_PAGE_FETCH_TIMEOUT_MS = 14000;
const SEARCH_RESULT_COUNT = 6;
const RAG_SEARCH_RESULT_COUNT = 10;
const RAG_MAX_PARALLEL_SEARCHES = 10;
const RAG_MAX_PARALLEL_FETCHES = 12;

/** Hosts where headless load triggers autoplay -- use search snippets only. */
const NON_FETCHABLE_URL = /(?:^|\/\/)(?:www\.)?(?:youtube\.com|youtu\.be|m\.youtube\.com|music\.youtube\.com|vimeo\.com|twitch\.tv|tiktok\.com|dailymotion\.com|facebook\.com\/watch|instagram\.com\/(?:reel|tv)|twitter\.com\/i\/broadcast|x\.com\/i\/broadcast)/i;

const MUTE_MEDIA_JS = `(() => {
  const stop = (el) => {
    try {
      el.muted = true;
      el.volume = 0;
      el.autoplay = false;
      el.removeAttribute('autoplay');
      if (typeof el.pause === 'function') el.pause();
    } catch (_) {}
  };
  document.querySelectorAll('video, audio').forEach(stop);
  document.querySelectorAll('iframe').forEach((f) => {
    try {
      const src = (f.src || '').toLowerCase();
      if (/youtube|vimeo|twitch|tiktok|facebook\\.com\\/plugins/.test(src)) {
        f.src = 'about:blank';
      }
    } catch (_) {}
  });
})();`;

function isNonFetchableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return NON_FETCHABLE_URL.test(url);
}

/**
 * Force silent scraping: muted audio, no autoplay, pause any media that starts.
 */
function wireSilentWebContents(webContents) {
  webContents.setAudioMuted(true);

  const killMedia = () => {
    if (webContents.isDestroyed()) return;
    webContents.executeJavaScript(MUTE_MEDIA_JS).catch(() => {});
  };

  webContents.on('dom-ready', killMedia);
  webContents.on('did-finish-load', killMedia);
  webContents.on('media-started-playing', () => {
    webContents.setAudioMuted(true);
    killMedia();
  });
}

function createSilentBrowserWindow(extra = {}) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      images: false,
      autoplayPolicy: 'document-user-activation-required',
      backgroundThrottling: true,
      ...extra.webPreferences
    },
    ...extra.window
  });
  wireSilentWebContents(win.webContents);
  return win;
}

function cleanPageText(raw) {
  if (!raw) return '';
  let text = raw;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/[\r\n]+/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n /g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Snippet-only result for video/social URLs — never opens a BrowserWindow.
 */
function snippetOnlyPageResult(url, meta = {}) {
  const title = meta.title || url;
  const snippet = (meta.snippet || '').trim();
  const content = [
    '[Source type: video/social — text extracted from search snippet only; no page load]',
    title ? `Title: ${title}` : '',
    snippet ? `Summary: ${snippet}` : '',
    'Note: Prefer written documentation sources in the final answer; cite this only for high-level context.'
  ].filter(Boolean).join('\n');

  return {
    success: true,
    title,
    meta: '',
    content: content.slice(0, meta.maxLen || RAG_MAX_PAGE_CONTENT_LENGTH),
    headings: [],
    url,
    snippet_only: true
  };
}

async function scrapePageInWindow(url, options = {}) {
  if (isNonFetchableUrl(url)) {
    return snippetOnlyPageResult(url, {
      title: options.title,
      snippet: options.snippet,
      maxLen: options.maxContentLength || RAG_MAX_PAGE_CONTENT_LENGTH
    });
  }

  const maxLen = options.maxContentLength || MAX_PAGE_CONTENT_LENGTH;
  const timeoutMs = options.timeoutMs || PAGE_FETCH_TIMEOUT_MS;
  const scrapeWindow = createSilentBrowserWindow();

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('Page load timeout')), timeoutMs);
  });

  try {
    await Promise.race([
      scrapeWindow.loadURL(url, { userAgent: options.userAgent }),
      timeoutPromise
    ]);
    clearTimeout(timeoutHandle);
    scrapeWindow.webContents.setAudioMuted(true);
    await scrapeWindow.webContents.executeJavaScript(MUTE_MEDIA_JS).catch(() => {});
    await new Promise((r) => setTimeout(r, options.renderWaitMs || 1500));
    scrapeWindow.webContents.setAudioMuted(true);

    const rawContent = await scrapeWindow.webContents.executeJavaScript(`
            (() => {
                const pickMain = () => {
                    const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content', '#content', '.content', '.markdown-body', '.documentation'];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.innerText.trim().length > 200) return el;
                    }
                    return document.body;
                };
                const root = pickMain();
                document.querySelectorAll('video, audio').forEach(el => { try { el.muted=true; el.pause(); } catch(e){} });
                const headings = Array.from(root.querySelectorAll('h1,h2,h3')).slice(0, 12).map(h => h.innerText.trim()).filter(Boolean);
                const codeBlocks = Array.from(root.querySelectorAll('pre,code')).slice(0, 8).map(el => el.innerText.trim()).filter(t => t.length > 20 && t.length < 8000);
                const text = root ? root.innerText.trim() : '';
                return {
                    title: document.title || '',
                    content: text,
                    meta: (document.querySelector('meta[name="description"]') || {}).content || '',
                    headings,
                    code_blocks: codeBlocks
                };
            })()
        `);

    let content = rawContent.content || '';
    if (rawContent.headings?.length) {
      content = 'HEADINGS: ' + rawContent.headings.join(' | ') + '\n\n' + content;
    }
    if (rawContent.code_blocks?.length) {
      content += '\n\n--- CODE FROM PAGE ---\n' + rawContent.code_blocks.slice(0, 4).join('\n\n---\n');
    }
    if (content.length > maxLen) {
      content = content.substring(0, maxLen) + '\n...[content truncated]';
    }

    return {
      success: true,
      title: rawContent.title || '',
      meta: rawContent.meta || '',
      content,
      headings: rawContent.headings || [],
      url
    };
  } catch (error) {
    clearTimeout(timeoutHandle);
    return { success: false, error: error.message, content: '', url };
  } finally {
    scrapeWindow.destroy();
  }
}

async function runSingleWebSearch(query, resultCount = SEARCH_RESULT_COUNT) {
  const searchWindow = createSilentBrowserWindow({
    window: { width: 1024, height: 768 },
    webPreferences: { images: false }
  });

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await searchWindow.loadURL(searchUrl);

    const results = await searchWindow.webContents.executeJavaScript(`
            (() => {
                const items = Array.from(document.querySelectorAll('.result'));
                return items.slice(0, ${resultCount}).map(item => {
                    const titleEl = item.querySelector('.result__a');
                    const snippetEl = item.querySelector('.result__snippet');
                    const urlEl = item.querySelector('.result__url');
                    return {
                        title: titleEl ? titleEl.innerText.trim() : '',
                        link: titleEl ? titleEl.href : '',
                        snippet: snippetEl ? snippetEl.innerText.trim() : '',
                        displayUrl: urlEl ? urlEl.innerText.trim() : ''
                    };
                });
            })()
        `);

    return { success: true, query, results };
  } catch (error) {
    console.error('[WebSearch] Error during search:', error);
    return { success: false, query, error: error.message, results: [] };
  } finally {
    searchWindow.destroy();
  }
}

function registerWebSearchIPC() {
  ipcMain.handle('perform-web-search', async (event, query) => {
    const out = await runSingleWebSearch(query, SEARCH_RESULT_COUNT);
    return { success: out.success, error: out.error, results: out.results || [] };
  });

  ipcMain.handle('perform-web-searches-parallel', async (event, queries) => {
    if (!Array.isArray(queries) || queries.length === 0) {
      return { success: false, searches: [] };
    }
    const limited = queries.slice(0, RAG_MAX_PARALLEL_SEARCHES);
    const searches = await Promise.all(
      limited.map((q) => runSingleWebSearch(String(q), RAG_SEARCH_RESULT_COUNT))
    );
    return { success: true, searches };
  });

  ipcMain.handle('fetch-page-content', async (event, url) => {
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Invalid URL', content: '' };
    }
    return scrapePageInWindow(url);
  });

  ipcMain.handle('fetch-pages-batch', async (event, urls) => {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { success: false, pages: [] };
    }
    const targetUrls = urls.slice(0, 3);
    const pages = await Promise.all(
      targetUrls.map((url) =>
        scrapePageInWindow(url, {
          maxContentLength: MAX_PAGE_CONTENT_LENGTH,
          timeoutMs: PAGE_FETCH_TIMEOUT_MS,
          renderWaitMs: 1200
        })
      )
    );
    return { success: true, pages };
  });

  ipcMain.handle('fetch-pages-batch-rag', async (event, urls) => {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { success: false, pages: [] };
    }
    const targetUrls = urls.slice(0, RAG_MAX_PARALLEL_FETCHES);
    const pages = await Promise.all(
      targetUrls.map((url) =>
        scrapePageInWindow(url, {
          maxContentLength: RAG_MAX_PAGE_CONTENT_LENGTH,
          timeoutMs: RAG_PAGE_FETCH_TIMEOUT_MS,
          renderWaitMs: 1800
        })
      )
    );
    return { success: true, pages };
  });
}

module.exports = {
  registerWebSearchIPC,
  isNonFetchableUrl,
  createSilentBrowserWindow
};
