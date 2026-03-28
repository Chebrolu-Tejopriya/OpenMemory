/**
 * OpenMemory - Background Service Worker
 * Handles side panel, idle-based indexing, metadata fetching, and Pinterest sync
 */

import { db, IndexedBookmark, IndexingQueueItem } from './db';
import {
  checkPinterestLogin,
  processPin,
  initializePinterestIntegration,
  updatePinterestIntegration,
  getPinterestIntegration,
  ScrapedBoard,
  ScrapedPin
} from './pinterest';
import {
  upsertBookmark,
  deleteBookmark,
  updateBookmark,
  bulkUpsertBookmarks,
  isSupabaseConfigured,
  setSupabaseConfig,
  getSyncStatus,
  updateSyncStatus
} from './supabase';

// ============== CONSTANTS ==============
const BATCH_SIZE = 5;
const IDLE_THRESHOLD = 60; // seconds
const FETCH_TIMEOUT = 10000; // 10 seconds
const MAX_CONTENT_LENGTH = 500;
const ALARM_NAME = 'checkIndexing';
const ALARM_PERIOD_MINUTES = 5;

// Pinterest sync constants
const PINTEREST_ALARM = 'pinterestSync';
const PINTEREST_SYNC_HOURS = 1;
const BATCH_DELAY_MS = 1200; // 50 pins/min = 1.2s delay

// Supabase auto-sync constants
const SUPABASE_SYNC_ALARM = 'supabaseAutoSync';
const SUPABASE_SYNC_MINUTES = 5; // Auto-sync every 5 minutes

// Blog URL patterns
const BLOG_URL_PATTERNS = [
  /\/blog\//i,
  /\/blogs\//i,
  /\/post\//i,
  /\/posts\//i,
  /\/article\//i,
  /\/articles\//i,
  /\/journal\//i,
  /\/news\//i,
  /\/stories?\//i,
  /medium\.com\//i,
  /dev\.to\//i,
  /hashnode\./i,
  /substack\./i
];

// ============== SIDE PANEL HANDLING ==============
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ============== INITIALIZATION ==============
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[OpenMemory] Extension installed/updated:', details.reason);
  await initializeDatabase();
  await initializePinterestIntegration();
  setupAlarms();

  // Auto-sync to Supabase after initialization if configured
  setTimeout(() => autoSyncToSupabase(), 5000);
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OpenMemory] Browser started');
  await initializePinterestIntegration();
  setupAlarms();

  // Auto-sync to Supabase on startup if configured
  setTimeout(() => autoSyncToSupabase(), 5000);
});

function setupAlarms() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  chrome.alarms.create(PINTEREST_ALARM, { periodInMinutes: PINTEREST_SYNC_HOURS * 60 });
  chrome.alarms.create(SUPABASE_SYNC_ALARM, { periodInMinutes: SUPABASE_SYNC_MINUTES });
}

// ============== IDLE-BASED INDEXING ==============
chrome.idle.onStateChanged.addListener((state) => {
  console.log('[OpenMemory] Idle state changed:', state);
  if (state === 'idle') {
    processIndexingQueue();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    chrome.idle.queryState(IDLE_THRESHOLD, (state) => {
      if (state === 'idle') {
        processIndexingQueue();
      }
    });
  }

  if (alarm.name === PINTEREST_ALARM) {
    syncPinterest();
  }

  if (alarm.name === SUPABASE_SYNC_ALARM) {
    autoSyncToSupabase();
  }
});

// ============== DATABASE INITIALIZATION ==============
async function initializeDatabase(): Promise<void> {
  try {
    const count = await db.bookmarks.count();
    console.log('[OpenMemory] Current bookmark count:', count);

    if (count === 0) {
      // Try to import from Chrome bookmarks first
      console.log('[OpenMemory] Importing Chrome bookmarks...');
      await importChromeBookmarks();
    }
  } catch (error) {
    console.error('[OpenMemory] Failed to initialize database:', error);
  }
}

// Import bookmarks from Chrome's bookmark API
async function importChromeBookmarks(): Promise<number> {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks: IndexedBookmark[] = [];

    // Recursively extract bookmarks
    function extractBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], folderPath: string = '') {
      for (const node of nodes) {
        if (node.url) {
          // It's a bookmark
          bookmarks.push({
            url: node.url,
            title: node.title || node.url,
            folder: folderPath || null,
            indexStatus: 'pending' as const
          });
        } else if (node.children) {
          // It's a folder
          const newPath = folderPath ? `${folderPath}/${node.title}` : node.title;
          extractBookmarks(node.children, newPath);
        }
      }
    }

    extractBookmarks(tree);

    if (bookmarks.length > 0) {
      // Filter out duplicates by URL
      const uniqueBookmarks = bookmarks.filter((b, index, self) =>
        index === self.findIndex(t => t.url === b.url)
      );

      await db.bookmarks.bulkAdd(uniqueBookmarks);
      console.log('[OpenMemory] Imported', uniqueBookmarks.length, 'Chrome bookmarks');

      // Add to indexing queue
      const queueItems: IndexingQueueItem[] = uniqueBookmarks.map((b, i) => ({
        url: b.url,
        priority: 1,
        createdAt: Date.now() - i
      }));
      await db.queue.bulkAdd(queueItems);

      return uniqueBookmarks.length;
    }

    return 0;
  } catch (error) {
    console.error('[OpenMemory] Failed to import Chrome bookmarks:', error);
    return 0;
  }
}

// Sync new Chrome bookmarks (call periodically or on demand)
async function syncChromeBookmarks(): Promise<number> {
  try {
    const tree = await chrome.bookmarks.getTree();
    const existingUrls = new Set((await db.bookmarks.toArray()).map(b => b.url));
    const newBookmarks: IndexedBookmark[] = [];

    function extractBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], folderPath: string = '') {
      for (const node of nodes) {
        if (node.url && !existingUrls.has(node.url)) {
          newBookmarks.push({
            url: node.url,
            title: node.title || node.url,
            folder: folderPath || null,
            indexStatus: 'pending' as const
          });
        } else if (node.children) {
          const newPath = folderPath ? `${folderPath}/${node.title}` : node.title;
          extractBookmarks(node.children, newPath);
        }
      }
    }

    extractBookmarks(tree);

    if (newBookmarks.length > 0) {
      await db.bookmarks.bulkAdd(newBookmarks);

      const queueItems: IndexingQueueItem[] = newBookmarks.map((b, i) => ({
        url: b.url,
        priority: 1,
        createdAt: Date.now() - i
      }));
      await db.queue.bulkAdd(queueItems);

      console.log('[OpenMemory] Synced', newBookmarks.length, 'new Chrome bookmarks');
    }

    return newBookmarks.length;
  } catch (error) {
    console.error('[OpenMemory] Failed to sync Chrome bookmarks:', error);
    return 0;
  }
}

// ============== REAL-TIME BOOKMARK SYNC ==============

// Listen for bookmark creation
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (bookmark.url) {
    const existing = await db.bookmarks.where('url').equals(bookmark.url).first();
    if (!existing) {
      // Get parent folder path
      let folderPath = '';
      if (bookmark.parentId) {
        folderPath = await getBookmarkFolderPath(bookmark.parentId);
      }

      // Add to local Dexie DB
      await db.bookmarks.add({
        url: bookmark.url,
        title: bookmark.title || bookmark.url,
        folder: folderPath || null,
        indexStatus: 'pending'
      });

      await db.queue.add({
        url: bookmark.url,
        priority: 2, // Higher priority for new bookmarks
        createdAt: Date.now()
      });

      console.log('[OpenMemory] Added new bookmark:', bookmark.title);

      // Sync to Supabase (incremental - only this bookmark)
      if (await isSupabaseConfigured()) {
        const result = await upsertBookmark({
          url: bookmark.url,
          title: bookmark.title || bookmark.url,
          folder: folderPath || null,
          chrome_id: id
        });

        if (result.success) {
          console.log('[Supabase] Synced new bookmark:', bookmark.title);
        } else {
          console.warn('[Supabase] Failed to sync bookmark:', result.error);
        }
      }
    }
  }
});

// Listen for bookmark removal
chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  console.log('[OpenMemory] Bookmark removed:', id);

  // Try to find the bookmark by chrome_id in removeInfo
  // Since we don't have the URL directly, we need to delete by chrome_id
  if (await isSupabaseConfigured()) {
    // Delete from Supabase using chrome_id
    const result = await deleteBookmark(id, 'chrome_id');

    if (result.success) {
      console.log('[Supabase] Deleted bookmark with chrome_id:', id);
    } else {
      console.warn('[Supabase] Failed to delete bookmark:', result.error);
    }
  }

  // Optionally delete from local DB too
  // If you want to keep deleted bookmarks locally, comment this out
  // await db.bookmarks.where('url').equals(removeInfo.node?.url || '').delete();
});

// Listen for bookmark changes (title or folder move)
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  console.log('[OpenMemory] Bookmark changed:', id, changeInfo);

  try {
    // Get the full bookmark to find URL
    const [bookmark] = await chrome.bookmarks.get(id);

    if (!bookmark || !bookmark.url) {
      return; // Folder change, not a bookmark
    }

    const oldTitle = changeInfo.title;
    const newTitle = bookmark.title;

    // Update local Dexie DB
    await db.bookmarks.where('url').equals(bookmark.url).modify({
      title: newTitle || bookmark.url
    });

    console.log('[OpenMemory] Updated bookmark title:', newTitle);

    // Sync to Supabase - will regenerate embedding if title changed
    if (await isSupabaseConfigured()) {
      const result = await updateBookmark(bookmark.url, {
        title: newTitle || bookmark.url
      });

      if (result.success) {
        console.log('[Supabase] Updated bookmark:', bookmark.url.substring(0, 50));
      } else {
        console.warn('[Supabase] Failed to update bookmark:', result.error);
      }
    }
  } catch (error) {
    console.error('[OpenMemory] Failed to handle bookmark change:', error);
  }
});

// Listen for bookmark moves (folder changes)
chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  console.log('[OpenMemory] Bookmark moved:', id, moveInfo);

  try {
    const [bookmark] = await chrome.bookmarks.get(id);

    if (!bookmark || !bookmark.url) {
      return; // Folder move, not a bookmark
    }

    // Get new folder path
    let newFolderPath = '';
    if (moveInfo.parentId) {
      newFolderPath = await getBookmarkFolderPath(moveInfo.parentId);
    }

    // Update local Dexie DB
    await db.bookmarks.where('url').equals(bookmark.url).modify({
      folder: newFolderPath || null
    });

    console.log('[OpenMemory] Updated bookmark folder:', newFolderPath);

    // Sync to Supabase - folder change doesn't require embedding regeneration
    if (await isSupabaseConfigured()) {
      const result = await updateBookmark(bookmark.url, {
        folder: newFolderPath || null
      });

      if (result.success) {
        console.log('[Supabase] Updated bookmark folder:', bookmark.url.substring(0, 50));
      } else {
        console.warn('[Supabase] Failed to update bookmark folder:', result.error);
      }
    }
  } catch (error) {
    console.error('[OpenMemory] Failed to handle bookmark move:', error);
  }
});

async function getBookmarkFolderPath(folderId: string): Promise<string> {
  const parts: string[] = [];
  let currentId = folderId;

  while (currentId) {
    try {
      const nodes = await chrome.bookmarks.get(currentId);
      if (nodes.length > 0 && nodes[0].title) {
        parts.unshift(nodes[0].title);
        currentId = nodes[0].parentId || '';
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return parts.join('/');
}

// ============== CORE INDEXING LOGIC ==============
let isProcessing = false;

async function processIndexingQueue(): Promise<void> {
  if (isProcessing) {
    console.log('[OpenMemory] Already processing, skipping...');
    return;
  }

  isProcessing = true;
  console.log('[OpenMemory] Starting queue processing...');

  try {
    const pendingItems = await db.queue
      .orderBy('priority')
      .reverse()
      .limit(BATCH_SIZE)
      .toArray();

    if (pendingItems.length === 0) {
      console.log('[OpenMemory] Queue is empty');
      isProcessing = false;
      return;
    }

    console.log('[OpenMemory] Processing', pendingItems.length, 'items');

    for (const item of pendingItems) {
      try {
        const metadata = await fetchPageMetadata(item.url);
        const contentType = classifyContentType(item.url, metadata);
        const extendedContent = buildExtendedContent(metadata);

        await db.bookmarks.where('url').equals(item.url).modify({
          extendedContent,
          contentType,
          indexedAt: Date.now(),
          indexStatus: 'indexed'
        });

        await db.queue.delete(item.id!);
        console.log('[OpenMemory] Indexed:', item.url.substring(0, 50) + '...');

      } catch (error) {
        console.error('[OpenMemory] Failed to index', item.url, error);

        await db.bookmarks.where('url').equals(item.url).modify({
          indexStatus: 'failed'
        });

        // Deprioritize failed items
        await db.queue.update(item.id!, { priority: 0 });
      }
    }
  } catch (error) {
    console.error('[OpenMemory] Queue processing error:', error);
  } finally {
    isProcessing = false;
  }
}

// ============== PAGE METADATA FETCHING ==============
interface PageMetadata {
  ogDescription?: string;
  metaDescription?: string;
  metaKeywords?: string;
  h1Text?: string;
  ogType?: string;
}

async function fetchPageMetadata(url: string): Promise<PageMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseHTML(html);

  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function parseHTML(html: string): PageMetadata {
  // Extract meta tags using regex (more reliable in service worker)
  const metadata: PageMetadata = {};

  // og:description
  const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  if (ogDescMatch) metadata.ogDescription = decodeHTMLEntities(ogDescMatch[1]);

  // meta description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  if (metaDescMatch) metadata.metaDescription = decodeHTMLEntities(metaDescMatch[1]);

  // meta keywords
  const keywordsMatch = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']keywords["']/i);
  if (keywordsMatch) metadata.metaKeywords = decodeHTMLEntities(keywordsMatch[1]);

  // og:type
  const ogTypeMatch = html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:type["']/i);
  if (ogTypeMatch) metadata.ogType = ogTypeMatch[1];

  // h1 text (first h1 only)
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) metadata.h1Text = decodeHTMLEntities(h1Match[1]).trim();

  return metadata;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ============== CONTENT CLASSIFICATION ==============
function classifyContentType(url: string, metadata: PageMetadata): string | null {
  // Check og:type first
  if (metadata.ogType === 'article') {
    return 'blog';
  }

  // Check URL patterns
  for (const pattern of BLOG_URL_PATTERNS) {
    if (pattern.test(url)) {
      return 'blog';
    }
  }

  return null;
}

function buildExtendedContent(metadata: PageMetadata): string {
  const parts: string[] = [];

  // Prefer og:description, fallback to meta description
  if (metadata.ogDescription) {
    parts.push(metadata.ogDescription);
  } else if (metadata.metaDescription) {
    parts.push(metadata.metaDescription);
  }

  // Add keywords
  if (metadata.metaKeywords) {
    parts.push(metadata.metaKeywords);
  }

  // Add h1 text
  if (metadata.h1Text) {
    parts.push(metadata.h1Text);
  }

  const combined = parts.join(' ').trim();
  return combined.substring(0, MAX_CONTENT_LENGTH);
}

// ============== PINTEREST SYNC ==============
let pinterestSyncInProgress = false;

async function discoverPinterestBoards(providedUsername?: string): Promise<{ boards: ScrapedBoard[]; username: string; loggedOut?: boolean } | null> {
  const { loggedIn } = await checkPinterestLogin();

  if (!loggedIn) {
    console.log('[Pinterest] Not logged in, cannot discover boards');
    return { boards: [], username: '', loggedOut: true };
  }

  let username = providedUsername;
  if (!username) {
    const stored = await chrome.storage.local.get('pinterestUsername');
    if (stored?.pinterestUsername) {
      username = stored.pinterestUsername;
    }
  }

  if (!username) {
    return { boards: [], username: '' };
  }

  console.log('[Pinterest] Discovering boards for user:', username);
  return { boards: [], username };
}

async function syncPinterest(providedUsername?: string, activeTabId?: number, deepSync?: boolean): Promise<void> {
  if (pinterestSyncInProgress) {
    console.log('[Pinterest] Sync already in progress, skipping...');
    return;
  }

  const { loggedIn, username: detectedUsername } = await checkPinterestLogin();
  let username = providedUsername || detectedUsername;

  if (!loggedIn) {
    console.log('[Pinterest] Not logged in, skipping sync');
    return;
  }

  if (!username) {
    const stored = await chrome.storage.local.get('pinterestUsername');
    if (stored?.pinterestUsername) {
      username = stored.pinterestUsername;
    }
  }

  if (!username && activeTabId) {
    try {
      await waitForTabLoad(activeTabId);
      const result = await chrome.tabs.sendMessage(activeTabId, { type: 'PINTEREST_ACTIVE_DETECT_USERNAME' });
      if (result?.loggedOut) {
        console.log('[Pinterest] User appears logged out, skipping sync');
        return;
      }
      if (result?.username) {
        username = result.username;
        await chrome.storage.local.set({ pinterestUsername: username });
      }
    } catch (error) {
      console.log('[Pinterest] Username detection failed:', error);
    }
  }

  if (!username) {
    console.log('[Pinterest] No username available, skipping sync');
    return;
  }

  pinterestSyncInProgress = true;
  console.log('[Pinterest] Starting sync for user:', username);

  await updatePinterestIntegration({
    connected: true,
    username,
    syncStatus: 'syncing',
    syncProgress: 0
  });

  try {
    const tabId = activeTabId ?? (await chrome.tabs.create({
      url: `https://www.pinterest.com/${username}/_saved/`,
      active: true
    })).id;

      if (!tabId) {
        await updatePinterestIntegration({ syncStatus: 'error' });
        return;
      }

    const tabInfo = await chrome.tabs.get(tabId);
    if (tabInfo?.url && !tabInfo.url.includes('/_saved/')) {
      const savedUrl = `https://www.pinterest.com/${username}/_saved/`;
      await chrome.tabs.update(tabId, { url: savedUrl });
    }

    await waitForTabLoad(tabId);
    await delay(1500);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'PINTEREST_ACTIVE_SET_PROGRESS',
        percent: 60,
        text: 'OpenMemory: Syncing your boards... 60%'
      });
    } catch (error) {
      console.warn('[Pinterest] Content script not available yet:', error);
    }

    let boardResponse;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        boardResponse = await chrome.tabs.sendMessage(tabId, {
          type: 'PINTEREST_ACTIVE_FETCH_BOARDS',
          username,
          deepSync: !!deepSync
        });
        break;
      } catch (error) {
        await delay(1000);
      }
    }

    const boards = (boardResponse?.boards || []) as ScrapedBoard[];
    if (boardResponse?.error) {
      console.warn('[Pinterest] Board fetch error:', boardResponse.error);
    }
    console.log('[Pinterest] Total boards discovered via HTML Parsing:', boards.length);

    if (boards.length === 0) {
      console.warn('[Pinterest] No boards found from active tab. Ensure Pinterest is fully loaded.');
      await updatePinterestIntegration({ syncStatus: 'error' });
      return;
    }

    await updatePinterestIntegration({
      boardTotal: boards.length,
      boardUpdated: 0,
      boardArchived: 0
    });

    let processedPins = 0;

    for (let i = 0; i < boards.length; i++) {
      const board = boards[i];
      console.log('[Pinterest] Scraping board:', board.name, '->', board.url);

      await chrome.tabs.update(tabId, { url: board.url });
      await waitForTabLoad(tabId);
      await delay(1200);

      let pinsResponse;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          pinsResponse = await chrome.tabs.sendMessage(tabId, {
            type: 'PINTEREST_ACTIVE_FETCH_PINS',
            boardId: board.boardId,
            boardUrl: board.url,
            deepSync: !!deepSync
          });
          break;
        } catch (error) {
          await delay(800);
        }
      }

      const pins = (pinsResponse?.pins || []) as ScrapedPin[];
      if (pinsResponse?.error) {
        console.warn('[Pinterest] Pin fetch error:', pinsResponse.error, board.url);
        console.warn('[Pinterest] Falling back to DOM extraction.');
      }
      console.log('[Pinterest] Found', pins.length, 'pins in', board.name);

      for (const pin of pins) {
        try {
          await processPin(pin, board.name, board.url);
          processedPins++;
        } catch (error) {
          console.warn('[Pinterest] Failed to process pin:', pin.pinId, error);
        }
      }

      const progress = Math.round(((i + 1) / boards.length) * 100);
      await updatePinterestIntegration({
        syncProgress: progress,
        totalPins: processedPins
      });
      await chrome.tabs.sendMessage(tabId, {
        type: 'PINTEREST_ACTIVE_SET_PROGRESS',
        percent: progress,
        text: `OpenMemory: Syncing your boards... ${progress}%`
      });
    }

    await updatePinterestIntegration({
      syncStatus: 'idle',
      syncProgress: 100,
      lastSyncAt: Date.now(),
      totalPins: processedPins
    });

    await chrome.tabs.sendMessage(tabId, {
      type: 'PINTEREST_ACTIVE_SET_PROGRESS',
      percent: 100,
      text: 'Sync Complete!',
      done: true
    });

    setTimeout(() => {
      chrome.tabs.remove(tabId).catch(() => undefined);
    }, 3000);

    console.log('[Pinterest] Sync complete. Processed', processedPins, 'pins');
  } catch (error) {
    console.error('[Pinterest] Sync failed:', error);
    await updatePinterestIntegration({ syncStatus: 'error' });
  } finally {
    pinterestSyncInProgress = false;
  }
}


function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Timeout fallback
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============== AUTOMATIC SUPABASE SYNC ==============
let supabaseSyncInProgress = false;

async function autoSyncToSupabase(): Promise<void> {
  if (supabaseSyncInProgress) {
    console.log('[Supabase] Auto-sync already in progress, skipping...');
    return;
  }

  if (!(await isSupabaseConfigured())) {
    console.log('[Supabase] Not configured, skipping auto-sync');
    return;
  }

  supabaseSyncInProgress = true;
  console.log('[Supabase] Starting automatic sync...');

  try {
    // Get all local bookmarks
    const allBookmarks = await db.bookmarks.toArray();
    console.log('[Supabase] Found', allBookmarks.length, 'local bookmarks');

    if (allBookmarks.length === 0) {
      console.log('[Supabase] No bookmarks to sync');
      return;
    }

    updateSyncStatus({ syncInProgress: true, pendingSync: allBookmarks.length });

    const bookmarkPayloads = allBookmarks.map(b => ({
      url: b.url,
      title: b.title,
      folder: b.folder,
      chrome_id: b.id?.toString()
    }));

    const result = await bulkUpsertBookmarks(bookmarkPayloads, (processed, total) => {
      updateSyncStatus({ pendingSync: total - processed });
    });

    updateSyncStatus({
      syncInProgress: false,
      lastSyncAt: Date.now(),
      totalSynced: result.success,
      pendingSync: 0
    });

    console.log('[Supabase] Auto-sync complete:', result.success, 'synced,', result.failed, 'failed');
  } catch (error) {
    console.error('[Supabase] Auto-sync failed:', error);
    updateSyncStatus({ syncInProgress: false });
  } finally {
    supabaseSyncInProgress = false;
  }
}

// ============== LOCAL EMBEDDINGS ==============
let offscreenDocumentReady = false;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenDocumentReady) return;

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Image conversion and local embeddings generation'
    });
    offscreenDocumentReady = true;
  } catch (error: any) {
    // Document might already exist
    if (error.message?.includes('Only a single offscreen')) {
      offscreenDocumentReady = true;
    } else {
      console.error('[Background] Failed to create offscreen document:', error);
    }
  }
}

async function generateEmbeddingLocal(text: string): Promise<number[] | null> {
  const config = await new Promise<{ url: string; anonKey: string } | null>((resolve) => {
    chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], (result) => {
      if (result.supabaseUrl && result.supabaseAnonKey) {
        resolve({ url: result.supabaseUrl, anonKey: result.supabaseAnonKey });
      } else {
        resolve(null);
      }
    });
  });

  if (!config) return null;

  try {
    const response = await fetch(`${config.url}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      console.error('[Background] Embedding API error:', response.status);
      return null;
    }

    const result = await response.json();
    return Array.isArray(result.embedding) ? result.embedding : null;
  } catch (error) {
    console.error('[Background] Embedding generation failed:', error);
    return null;
  }
}

// Generate embeddings for all bookmarks in Supabase
async function generateEmbeddingsForAllBookmarks(): Promise<{ success: number; failed: number }> {
  const config = await new Promise<{ url: string; anonKey: string } | null>((resolve) => {
    chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], (result) => {
      if (result.supabaseUrl && result.supabaseAnonKey) {
        resolve({ url: result.supabaseUrl, anonKey: result.supabaseAnonKey });
      } else {
        resolve(null);
      }
    });
  });

  if (!config) return { success: 0, failed: 0 };

  console.log('[Background] Starting embedding generation with Hugging Face API...');

  // Get all bookmarks without embeddings
  const response = await fetch(`${config.url}/rest/v1/bookmarks?embedding=is.null&select=id,title,folder`, {
    headers: {
      'apikey': config.anonKey,
      'Authorization': `Bearer ${config.anonKey}`
    }
  });

  if (!response.ok) {
    console.error('[Background] Failed to fetch bookmarks');
    return { success: 0, failed: 0 };
  }

  const bookmarks = await response.json();
  console.log(`[Background] Generating embeddings for ${bookmarks.length} bookmarks...`);

  let success = 0;
  let failed = 0;

  // Process one at a time with delay to avoid rate limits
  for (let i = 0; i < bookmarks.length; i++) {
    const bookmark = bookmarks[i];
    const text = `${bookmark.title} ${bookmark.folder || ''}`.trim();

    try {
      const embedding = await generateEmbeddingLocal(text);

      if (embedding && embedding.length > 0) {
        // Update the bookmark with embedding
        const updateResponse = await fetch(`${config.url}/rest/v1/bookmarks?id=eq.${bookmark.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': config.anonKey,
            'Authorization': `Bearer ${config.anonKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ embedding })
        });

        if (updateResponse.ok) {
          success++;
        } else {
          console.error('[Background] Failed to update bookmark:', await updateResponse.text());
          failed++;
        }
      } else {
        failed++;
      }
    } catch (error) {
      console.error('[Background] Error processing bookmark:', error);
      failed++;
    }

    // Log progress every 10 bookmarks
    if ((i + 1) % 10 === 0 || i === bookmarks.length - 1) {
      const progress = Math.round(((i + 1) / bookmarks.length) * 100);
      console.log(`[Background] Embedding progress: ${progress}% (${success} success, ${failed} failed)`);
    }

    // Delay to avoid rate limits (HF free tier has limits)
    await delay(500);
  }

  console.log(`[Background] Embedding generation complete: ${success} success, ${failed} failed`);
  return { success, failed };
}

// ============== MESSAGE HANDLING FOR UI ==============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Local embedding generation for search
  if (message.type === 'GENERATE_EMBEDDING_LOCAL') {
    generateEmbeddingLocal(message.text).then(embedding => {
      sendResponse({ embedding });
    });
    return true;
  }

  if (message.type === 'GENERATE_EMBEDDINGS_FOR_BOOKMARKS') {
    generateEmbeddingsForAllBookmarks().then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'GET_INDEXING_STATUS') {
    getIndexingStatus().then(sendResponse);
    return true; // Async response
  }

  if (message.type === 'TRIGGER_INDEXING') {
    processIndexingQueue().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'RETRY_FAILED_INDEXING') {
    (async () => {
      try {
        const failedBookmarks = await db.bookmarks.where('indexStatus').equals('failed').toArray();
        const existingUrls = new Set((await db.queue.toArray()).map(item => item.url));

        const queueItems = failedBookmarks
          .filter(item => !existingUrls.has(item.url))
          .map((item, i) => ({
            url: item.url,
            priority: 2,
            createdAt: Date.now() - i
          }));

        if (queueItems.length > 0) {
          await db.queue.bulkAdd(queueItems);
          await db.bookmarks.where('indexStatus').equals('failed').modify({
            indexStatus: 'pending'
          });
        }

        sendResponse({ success: true, count: queueItems.length });
        processIndexingQueue();
      } catch (error) {
        sendResponse({ success: false });
      }
    })();
    return true;
  }

  if (message.type === 'GET_ALL_BOOKMARKS') {
    db.bookmarks.toArray().then(sendResponse);
    return true;
  }

  // Pinterest messages
  if (message.type === 'CHECK_PINTEREST_LOGIN') {
    checkPinterestLogin().then(sendResponse);
    return true;
  }

  if (message.type === 'TRIGGER_PINTEREST_SYNC') {
    const username = message.username;
    const tabId = message.tabId as number | undefined;
    const deepSync = !!message.deepSync;
    syncPinterest(username, tabId, deepSync).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_BOARDS') {
    (async () => {
      try {
        const username = message.username as string;
        const boards = (message.boards || []) as ScrapedBoard[];
        const existingBoardUrls = new Set((await db.pinterestBoards.toArray()).map(b => b.url));

        for (const board of boards) {
          if (!existingBoardUrls.has(board.url)) {
            await db.pinterestBoards.add({
              boardId: board.boardId || `slug:${board.url}`,
              name: board.name,
              url: board.url,
              pinCount: board.pinCount || 0,
              archived: false,
              updatedAt: Date.now()
            });
          }
        }

        await updatePinterestIntegration({
          connected: true,
          username,
          syncStatus: 'syncing',
          syncProgress: 0,
          boardTotal: boards.length
        });

        sendResponse({ success: true });
      } catch (error) {
        await updatePinterestIntegration({ syncStatus: 'error' });
        sendResponse({ success: false });
      }
    })();
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_PINS') {
    (async () => {
      try {
        const username = message.username as string;
        const boardName = message.boardName as string;
        const boardUrl = message.boardUrl as string;
        const pins = (message.pins || []) as ScrapedPin[];
        const progress = typeof message.progress === 'number' ? message.progress : 0;

        for (const pin of pins) {
          try {
            await processPin(pin, boardName, boardUrl);
            await delay(BATCH_DELAY_MS);
          } catch (error) {
            console.warn('[Pinterest] Failed to process pin:', pin.pinId, error);
          }
        }

        const totalPins = await db.pins.count();
        await updatePinterestIntegration({
          connected: true,
          username,
          syncStatus: progress >= 100 ? 'idle' : 'syncing',
          syncProgress: Math.min(100, Math.max(0, progress)),
          lastSyncAt: progress >= 100 ? Date.now() : undefined,
          totalPins
        });

        sendResponse({ success: true });
      } catch (error) {
        await updatePinterestIntegration({ syncStatus: 'error' });
        sendResponse({ success: false });
      }
    })();
    return true;
  }

  if (message.type === 'DISCOVER_PINTEREST_BOARDS') {
    discoverPinterestBoards(message.username)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'GET_PINTEREST_STATUS') {
    getPinterestIntegration().then(sendResponse);
    return true;
  }

  if (message.type === 'GET_ALL_PINS') {
    db.pins.toArray().then(sendResponse);
    return true;
  }

  if (message.type === 'DISCONNECT_PINTEREST') {
    (async () => {
      await updatePinterestIntegration({
        connected: false,
        username: undefined,
        syncStatus: 'idle',
        syncProgress: 0
      });
      // Optionally clear pins
      await db.pins.clear();
      sendResponse({ success: true });
    })();
    return true;
  }

  // Chrome bookmarks messages
  if (message.type === 'SYNC_CHROME_BOOKMARKS') {
    syncChromeBookmarks().then(count => sendResponse({ success: true, count }));
    return true;
  }

  if (message.type === 'IMPORT_CHROME_BOOKMARKS') {
    importChromeBookmarks().then(count => sendResponse({ success: true, count }));
    return true;
  }

  // ============== SUPABASE SYNC MESSAGES ==============

  if (message.type === 'CONFIGURE_SUPABASE') {
    (async () => {
      try {
        const { url, anonKey } = message;
        if (!url || !anonKey) {
          sendResponse({ success: false, error: 'Missing url or anonKey' });
          return;
        }
        await setSupabaseConfig(url, anonKey);
        sendResponse({ success: true });

        // Automatically sync all bookmarks after configuration
        console.log('[Supabase] Config saved, triggering auto-sync...');
        setTimeout(() => autoSyncToSupabase(), 1000);
      } catch (error) {
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === 'CHECK_SUPABASE_CONFIG') {
    isSupabaseConfigured().then(configured => sendResponse({ configured }));
    return true;
  }

  if (message.type === 'GET_SUPABASE_SYNC_STATUS') {
    sendResponse(getSyncStatus());
    return true;
  }

  if (message.type === 'SYNC_ALL_TO_SUPABASE') {
    (async () => {
      try {
        if (!(await isSupabaseConfigured())) {
          sendResponse({ success: false, error: 'Supabase not configured' });
          return;
        }

        updateSyncStatus({ syncInProgress: true, pendingSync: 0 });

        // Get all bookmarks from local DB
        const allBookmarks = await db.bookmarks.toArray();

        console.log('[Supabase] Starting full sync of', allBookmarks.length, 'bookmarks');

        const bookmarkPayloads = allBookmarks.map(b => ({
          url: b.url,
          title: b.title,
          folder: b.folder,
          chrome_id: b.id?.toString()
        }));

        const result = await bulkUpsertBookmarks(bookmarkPayloads, (processed, total) => {
          updateSyncStatus({ pendingSync: total - processed });
        });

        updateSyncStatus({
          syncInProgress: false,
          lastSyncAt: Date.now(),
          totalSynced: result.success,
          pendingSync: 0
        });

        console.log('[Supabase] Full sync complete:', result);
        sendResponse({ success: true, ...result });
      } catch (error) {
        updateSyncStatus({ syncInProgress: false });
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === 'SYNC_BOOKMARK_TO_SUPABASE') {
    (async () => {
      try {
        const { url, title, folder } = message;
        if (!url) {
          sendResponse({ success: false, error: 'Missing url' });
          return;
        }
        const result = await upsertBookmark({ url, title, folder });
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === 'DELETE_BOOKMARK_FROM_SUPABASE') {
    (async () => {
      try {
        const { url, chromeId } = message;
        const field = chromeId ? 'chrome_id' : 'url';
        const value = chromeId || url;

        if (!value) {
          sendResponse({ success: false, error: 'Missing url or chromeId' });
          return;
        }

        const result = await deleteBookmark(value, field);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_SYNC_DATA') {
    (async () => {
      try {
        const username = message.username as string;
        const boardName = message.boardName as string;
        const boardUrl = message.boardUrl as string;
        const pins = (message.pins || []) as ScrapedPin[];

        for (const pin of pins) {
          try {
            await processPin(pin, boardName, boardUrl);
            await delay(BATCH_DELAY_MS);
          } catch (error) {
            console.warn('[Pinterest] Failed to process pin:', pin.pinId, error);
          }
        }

        const totalPins = await db.pins.count();
        await updatePinterestIntegration({
          connected: true,
          username,
          syncStatus: 'idle',
          syncProgress: 100,
          lastSyncAt: Date.now(),
          totalPins
        });

        sendResponse({ success: true });
      } catch (error) {
        await updatePinterestIntegration({ syncStatus: 'error' });
        sendResponse({ success: false });
      }
    })();
    return true;
  }
});

async function getIndexingStatus(): Promise<{
  total: number;
  indexed: number;
  pending: number;
  failed: number;
}> {
  const [total, indexed, pending, failed] = await Promise.all([
    db.bookmarks.count(),
    db.bookmarks.where('indexStatus').equals('indexed').count(),
    db.bookmarks.where('indexStatus').equals('pending').count(),
    db.bookmarks.where('indexStatus').equals('failed').count()
  ]);

  return { total, indexed, pending, failed };
}
