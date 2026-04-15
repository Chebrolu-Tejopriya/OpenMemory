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
  fetchPinterestBoards,
  fetchPinterestBoardPins,
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
  updateSyncStatus,
  getPinterestBoards,
  resyncPinterestBoard,
  bulkInsertPinterestPins,
  PinterestPinInsert,
  backfillAllMissingEmbeddings,
  getAllSupabaseBookmarkUrls,
} from './supabase';

// ============== CONSTANTS ==============
const BATCH_SIZE = 20; // Process more items at once
const IDLE_THRESHOLD = 30; // seconds - start sooner
const FETCH_TIMEOUT = 8000; // 8 seconds
const MAX_CONTENT_LENGTH = 500;
const ALARM_NAME = 'checkIndexing';
const ALARM_PERIOD_MINUTES = 2; // Check more frequently

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
  // Reconcile any bookmarks deleted while the extension was not running
  setTimeout(() => reconcileDeletedBookmarks(), 8000);
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OpenMemory] Browser started');
  await initializePinterestIntegration();
  setupAlarms();

  // Auto-sync to Supabase on startup if configured
  setTimeout(() => autoSyncToSupabase(), 5000);
  // Reconcile any bookmarks deleted while the browser was closed
  setTimeout(() => reconcileDeletedBookmarks(), 8000);
});

// ============== RECONCILIATION ==============

/** Collect every URL from Chrome's full bookmark tree */
function getAllChromeBookmarkUrls(): Promise<Set<string>> {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const urls = new Set<string>();
      const traverse = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
        for (const node of nodes) {
          if (node.url) urls.add(node.url);
          if (node.children) traverse(node.children);
        }
      };
      traverse(tree);
      resolve(urls);
    });
  });
}

/**
 * Compare Chrome bookmarks against Supabase and delete any rows whose
 * URLs no longer exist in Chrome. Runs silently on startup/install.
 */
async function reconcileDeletedBookmarks() {
  if (!(await isSupabaseConfigured())) return;

  console.log('[OpenMemory] Reconciliation: checking for orphaned bookmarks...');

  try {
    const [supabaseUrls, chromeUrls] = await Promise.all([
      getAllSupabaseBookmarkUrls(),
      getAllChromeBookmarkUrls(),
    ]);

    if (supabaseUrls.length === 0) return;

    const orphaned = supabaseUrls.filter((url) => !chromeUrls.has(url));

    if (orphaned.length === 0) {
      console.log('[OpenMemory] Reconciliation: all Supabase bookmarks accounted for');
      return;
    }

    console.log(`[OpenMemory] Reconciliation: deleting ${orphaned.length} orphaned bookmark(s)...`);

    let deleted = 0;
    for (const url of orphaned) {
      const result = await deleteBookmark(url, 'url');
      if (result.success) deleted++;
    }

    console.log(`[OpenMemory] Reconciliation complete: ${deleted}/${orphaned.length} deleted`);
  } catch (err) {
    console.error('[OpenMemory] Reconciliation error:', err);
  }
}

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
    // Auto Pinterest sync if username is saved
    autoPinterestSync();
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
async function syncChromeBookmarks(): Promise<{ newCount: number; totalCount: number }> {
  try {
    const tree = await chrome.bookmarks.getTree();
    const existingUrls = new Set((await db.bookmarks.toArray()).map(b => b.url));
    const newBookmarks: IndexedBookmark[] = [];
    let totalChromeBookmarks = 0;

    function extractBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], folderPath: string = '') {
      for (const node of nodes) {
        if (node.url) {
          totalChromeBookmarks++;
          if (!existingUrls.has(node.url)) {
            newBookmarks.push({
              url: node.url,
              title: node.title || node.url,
              folder: folderPath || null,
              indexStatus: 'pending' as const
            });
          }
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

    console.log('[OpenMemory] Total Chrome bookmarks:', totalChromeBookmarks, 'Local DB:', existingUrls.size + newBookmarks.length);
    return { newCount: newBookmarks.length, totalCount: totalChromeBookmarks };
  } catch (error) {
    console.error('[OpenMemory] Failed to sync Chrome bookmarks:', error);
    return { newCount: 0, totalCount: 0 };
  }
}

// Get actual Chrome bookmark count
async function getChromeBookmarkCount(): Promise<number> {
  try {
    const tree = await chrome.bookmarks.getTree();
    let count = 0;

    function countBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]) {
      for (const node of nodes) {
        if (node.url) {
          count++;
        } else if (node.children) {
          countBookmarks(node.children);
        }
      }
    }

    countBookmarks(tree);
    return count;
  } catch (error) {
    console.error('[OpenMemory] Failed to count Chrome bookmarks:', error);
    return 0;
  }
}

// ============== REAL-TIME BOOKMARK SYNC ==============

// Listen for bookmark creation
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  console.log('[OpenMemory] Bookmark created event fired:', { id, url: bookmark.url, title: bookmark.title });

  if (bookmark.url) {
    // Get parent folder path
    let folderPath = '';
    if (bookmark.parentId) {
      folderPath = await getBookmarkFolderPath(bookmark.parentId);
    }

    const existing = await db.bookmarks.where('url').equals(bookmark.url).first();
    console.log('[OpenMemory] Existing bookmark check:', existing ? 'exists' : 'new');

    if (!existing) {
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
    }

    // ALWAYS sync to Supabase when a bookmark is created (regardless of local state)
    const isConfigured = await isSupabaseConfigured();
    console.log('[Supabase] Is configured:', isConfigured);

    if (isConfigured) {
      console.log('[Supabase] Syncing bookmark to Supabase...');
      try {
        const result = await upsertBookmark({
          url: bookmark.url,
          title: bookmark.title || bookmark.url,
          folder: folderPath || null,
          chrome_id: id
        });

        if (result.success) {
          console.log('[Supabase] ✓ Synced bookmark:', bookmark.title);
        } else {
          console.error('[Supabase] ✗ Failed to sync bookmark:', result.error);
        }
      } catch (err) {
        console.error('[Supabase] Exception during sync:', err);
      }
    } else {
      console.log('[Supabase] Not configured, skipping sync');
    }
  }
});

// Listen for bookmark removal
chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  console.log('[OpenMemory] Bookmark removed:', id, removeInfo);

  // Get the URL from removeInfo.node (available in Chrome)
  const removedUrl = (removeInfo as any).node?.url;
  console.log('[OpenMemory] Removed bookmark URL:', removedUrl);

  // Delete from local Dexie DB
  if (removedUrl) {
    try {
      await db.bookmarks.where('url').equals(removedUrl).delete();
      await db.queue.where('url').equals(removedUrl).delete();
      console.log('[OpenMemory] Deleted from local DB:', removedUrl);
    } catch (err) {
      console.warn('[OpenMemory] Failed to delete from local DB:', err);
    }
  }

  // Delete from Supabase
  if (await isSupabaseConfigured()) {
    let deleted = false;

    // Try to delete by URL first (more reliable)
    if (removedUrl) {
      const result = await deleteBookmark(removedUrl, 'url');
      if (result.success) {
        console.log('[Supabase] ✓ Deleted bookmark by URL:', removedUrl);
        deleted = true;
      }
    }

    // Fallback: try to delete by chrome_id
    if (!deleted) {
      const result = await deleteBookmark(id, 'chrome_id');
      if (result.success) {
        console.log('[Supabase] ✓ Deleted bookmark by chrome_id:', id);
      } else {
        console.warn('[Supabase] ✗ Failed to delete bookmark:', result.error);
      }
    }
  }
});

// Listen for bookmark changes (title change)
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  console.log('[OpenMemory] Bookmark changed:', id, changeInfo);

  try {
    // Get the full bookmark to find URL
    const [bookmark] = await chrome.bookmarks.get(id);

    if (!bookmark || !bookmark.url) {
      return; // Folder change, not a bookmark
    }

    const newTitle = bookmark.title;

    // Update local Dexie DB
    await db.bookmarks.where('url').equals(bookmark.url).modify({
      title: newTitle || bookmark.url
    });

    console.log('[OpenMemory] Updated bookmark title locally:', newTitle);

    // Sync to Supabase - will regenerate embedding if title changed
    if (await isSupabaseConfigured()) {
      console.log('[Supabase] Updating bookmark title...');
      const result = await updateBookmark(bookmark.url, {
        title: newTitle || bookmark.url
      });

      if (result.success) {
        console.log('[Supabase] ✓ Updated bookmark title:', bookmark.url.substring(0, 50));
      } else {
        console.warn('[Supabase] ✗ Failed to update bookmark:', result.error);
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

    console.log('[OpenMemory] Updated bookmark folder locally:', newFolderPath);

    // Sync to Supabase - folder change doesn't require embedding regeneration
    if (await isSupabaseConfigured()) {
      console.log('[Supabase] Updating bookmark folder...');
      const result = await updateBookmark(bookmark.url, {
        folder: newFolderPath || undefined
      });

      if (result.success) {
        console.log('[Supabase] ✓ Updated bookmark folder:', bookmark.url.substring(0, 50));
      } else {
        console.warn('[Supabase] ✗ Failed to update bookmark folder:', result.error);
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

    // Auto-sync Pinterest pins to Supabase for semantic search
    if (await isSupabaseConfigured()) {
      console.log('[Pinterest] Syncing pins to Supabase for AI search...');
      syncPinterestPinsToSupabase().then(result => {
        console.log('[Pinterest] Supabase sync complete:', result.success, 'pins');
      });
    }
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

function extractPinId(pinUrl: string): string {
  const match = pinUrl.match(/\/pin\/(\d+)/);
  return match?.[1] || '';
}

function isValidSupabasePinPayload(pin: { pin_url: string; image_url: string; pin_id: string }): boolean {
  if (!pin.pin_url || !pin.image_url) return false;
  if (pin.image_url.startsWith('data:')) return false;
  if (!pin.pin_id) return false;
  return true;
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

    if (allBookmarks.length > 0) {
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

      console.log('[Supabase] Bookmarks sync complete:', result.success, 'synced,', result.failed, 'failed');
    }

    // Sync Pinterest pins too
    await syncPinterestPinsToSupabase();

    // Backfill any missing embeddings (runs in background)
    console.log('[Supabase] Checking for missing embeddings...');
    backfillAllMissingEmbeddings().catch(err => {
      console.error('[Supabase] Embedding backfill failed:', err);
    });

    updateSyncStatus({
      syncInProgress: false,
      lastSyncAt: Date.now(),
      pendingSync: 0
    });

  } catch (error) {
    console.error('[Supabase] Auto-sync failed:', error);
    updateSyncStatus({ syncInProgress: false });
  } finally {
    supabaseSyncInProgress = false;
  }
}

// ============== AUTO PINTEREST SYNC ==============
async function autoPinterestSync(): Promise<void> {
  // Check if user has connected Pinterest before
  const stored = await chrome.storage.local.get('pinterestUsername');
  const username = stored?.pinterestUsername;

  if (!username) {
    console.log('[Pinterest] No username saved, skipping auto-sync');
    return;
  }

  // Check if logged in
  const { loggedIn } = await checkPinterestLogin();
  if (!loggedIn) {
    console.log('[Pinterest] Not logged in, skipping auto-sync');
    return;
  }

  // Check if already syncing
  if (pinterestSyncInProgress) {
    console.log('[Pinterest] Sync already in progress, skipping');
    return;
  }

  console.log('[Pinterest] Starting auto-sync for:', username);
  pinterestSyncInProgress = true;

  try {
    await fastPinterestSync(username);
  } finally {
    pinterestSyncInProgress = false;
  }
}

// ============== FAST PINTEREST SYNC (uses single tab + content script API calls) ==============
async function fastPinterestSync(username: string): Promise<{ boards: number; pins: number }> {
  console.log('[Pinterest] Starting FAST sync for:', username);

  await updatePinterestIntegration({
    connected: true,
    username,
    syncStatus: 'syncing',
    syncProgress: 0
  });

  let tabId: number | undefined;

  try {
    // Detect which Pinterest domain the user is logged into
    const pinterestDomains = [
      'https://in.pinterest.com',
      'https://www.pinterest.com',
      'https://pinterest.com',
      'https://br.pinterest.com',
      'https://de.pinterest.com',
      'https://fr.pinterest.com',
      'https://uk.pinterest.com'
    ];

    let activeDomain = 'https://www.pinterest.com';
    for (const domain of pinterestDomains) {
      const cookie = await chrome.cookies.get({ url: domain, name: '_pinterest_sess' });
      if (cookie) {
        activeDomain = domain;
        console.log('[Pinterest] Found active session on:', domain);
        break;
      }
    }

    // Open Pinterest boards page (not _saved, which shows fewer boards)
    const boardsUrl = `${activeDomain}/${username}/boards/`;
    console.log('[Pinterest] Opening:', boardsUrl);
    const tab = await chrome.tabs.create({ url: boardsUrl, active: false });
    tabId = tab.id;

    if (!tabId) {
      throw new Error('Failed to create Pinterest tab');
    }

    // Wait for tab to load
    await waitForTabLoad(tabId);
    await delay(1500);

    // Fetch all boards via content script API
    console.log('[Pinterest] Fetching boards via content script...');
    let boardResponse;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        boardResponse = await chrome.tabs.sendMessage(tabId, {
          type: 'PINTEREST_ACTIVE_FETCH_BOARDS',
          username,
          deepSync: false
        });
        break;
      } catch (error) {
        console.log('[Pinterest] Waiting for content script...', attempt + 1);
        await delay(1000);
      }
    }

    const boards = (boardResponse?.boards || []) as Array<{ boardId?: string; name: string; url: string; pinCount?: number }>;

    // Log detailed content script logs
    if (boardResponse?.logs) {
      console.log('[Pinterest] === Content Script Logs ===');
      (boardResponse.logs as string[]).forEach(log => console.log(log));
      console.log('[Pinterest] === End Content Script Logs ===');
    }

    if (boards.length === 0) {
      console.log('[Pinterest] No boards found. Response:', boardResponse);
      await updatePinterestIntegration({ syncStatus: 'error' });
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      return { boards: 0, pins: 0 };
    }

    console.log('[Pinterest] Found', boards.length, 'boards:');
    boards.forEach((b, i) => console.log(`  ${i + 1}. "${b.name}" (id: ${b.boardId}, pins: ${b.pinCount || '?'})`));
    await updatePinterestIntegration({ boardTotal: boards.length });

    let totalPins = 0;
    let boardsWithPins = 0;
    let boardsFailed = 0;

    // Fetch pins from each board - navigate to board page for DOM extraction
    for (let i = 0; i < boards.length; i++) {
      const board = boards[i];
      const boardId = board.boardId;

      console.log(`[Pinterest] Fetching pins from "${board.name}" (${i + 1}/${boards.length})`);

      try {
        // Navigate to the board page
        console.log(`[Pinterest] Navigating to: ${board.url}`);
        await chrome.tabs.update(tabId, { url: board.url });
        await waitForTabLoad(tabId);
        await delay(800); // Reduced delay

        // Use content script to extract pins
        let pinsResponse;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            pinsResponse = await chrome.tabs.sendMessage(tabId, {
              type: 'PINTEREST_ACTIVE_FETCH_PINS',
              boardId: boardId,
              boardUrl: board.url,
              deepSync: false
            });
            break;
          } catch (err) {
            console.log(`[Pinterest] Waiting for content script... attempt ${attempt + 1}`);
            await delay(500);
          }
        }

        const pins = (pinsResponse?.pins || []) as Array<{ pinId: string; title: string; description?: string; imageUrl: string; pinUrl: string }>;

        if (pinsResponse?.error) {
          console.log(`[Pinterest] API error for "${board.name}": ${pinsResponse.error} - using DOM extraction`);
        }

        if (pins.length > 0) {
          boardsWithPins++;
          console.log(`[Pinterest] ✓ Got ${pins.length} pins from "${board.name}"`);
        } else {
          boardsFailed++;
          console.log(`[Pinterest] ✗ Got 0 pins from "${board.name}" (expected: ${board.pinCount || '?'})`);
        }

        // Process each pin
        for (const pin of pins) {
          try {
            await processPin({
              pinId: pin.pinId,
              title: pin.title,
              description: pin.description,
              imageUrl: pin.imageUrl,
              pinUrl: pin.pinUrl
            }, board.name, board.url);
            totalPins++;
          } catch (err) {
            // Pin might already exist, continue
          }
        }

        // Update progress
        const progress = Math.round(((i + 1) / boards.length) * 100);
        await updatePinterestIntegration({
          syncProgress: progress,
          totalPins,
          boardUpdated: i + 1
        });

      } catch (err) {
        console.warn(`[Pinterest] Failed to fetch pins from "${board.name}":`, err);
        boardsFailed++;
      }
    }

    await updatePinterestIntegration({
      syncStatus: 'idle',
      syncProgress: 100,
      lastSyncAt: Date.now(),
      totalPins
    });

    console.log('[Pinterest] ===== SYNC SUMMARY =====');
    console.log(`[Pinterest] Boards found: ${boards.length}`);
    console.log(`[Pinterest] Boards with pins: ${boardsWithPins}`);
    console.log(`[Pinterest] Boards failed: ${boardsFailed}`);
    console.log(`[Pinterest] Total pins synced: ${totalPins}`);
    console.log('[Pinterest] ==========================');

    // Close the tab
    if (tabId) {
      chrome.tabs.remove(tabId).catch(() => {});
    }

    // Auto-sync to Supabase
    if (await isSupabaseConfigured()) {
      console.log('[Pinterest] Syncing pins to Supabase...');
      syncPinterestPinsToSupabase();
    }

    return { boards: boards.length, pins: totalPins };
  } catch (error) {
    console.error('[Pinterest] Fast sync failed:', error);
    await updatePinterestIntegration({ syncStatus: 'error' });
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    return { boards: 0, pins: 0 };
  }
}

// ============== PINTEREST BATCH UPLOAD ==============
interface ExtractedPin {
  pinId: string;
  title: string;
  description?: string;
  imageUrl: string;
  pinUrl: string;
  source: 'pinterest';
  type: 'image';
}

async function uploadPinsToSupabase(
  pins: ExtractedPin[],
  boardName: string,
  boardUrl: string,
  totalPins?: number | null
): Promise<{ added: number; total: number; failed: number }> {
  // Save to local DB
  for (const pin of pins) {
    try {
      await processPin({
        pinId: pin.pinId || extractPinId(pin.pinUrl),
        title: pin.title,
        description: pin.description,
        imageUrl: pin.imageUrl,
        pinUrl: pin.pinUrl
      }, boardName, boardUrl);
    } catch (e) {
      // Pin might already exist
    }
  }

  const now = new Date().toISOString();
  const payloads: PinterestPinInsert[] = pins
    .map(pin => ({
      pin_id: extractPinId(pin.pinUrl),
      pin_url: pin.pinUrl,
      image_url: pin.imageUrl,
      title: pin.title || '',
      description: pin.description || null,
      board_name: boardName,
      board_url: boardUrl,
      created_at: now
    }))
    .filter(pin => isValidSupabasePinPayload(pin));

  const result = await resyncPinterestBoard(boardUrl, payloads, boardName, totalPins ?? null);
  const failed = Math.max(0, payloads.length - result.added);
  return { added: result.added, total: result.total, failed };
}

// ============== PINTEREST PINS SUPABASE SYNC ==============
async function syncPinterestPinsToSupabase(): Promise<{ success: number; failed: number }> {
  return { success: 0, failed: 0 };
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

  if (message.type === 'FAST_PINTEREST_SYNC') {
    const username = message.username;
    if (!username) {
      sendResponse({ success: false, error: 'Username required' });
      return true;
    }
    fastPinterestSync(username).then(result => {
      sendResponse({ success: true, ...result });
    });
    return true;
  }

  // ============== NEW PINTEREST IMPORT HANDLERS ==============

  // Import current board (triggered from popup/sidepanel)
  if (message.type === 'PINTEREST_IMPORT_CURRENT_BOARD') {
    (async () => {
      try {
        // Get current active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url?.includes('pinterest.com')) {
          sendResponse({ success: false, error: 'Please open a Pinterest board page first' });
          return;
        }

        // Inject content script if needed
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['pinterest_active.js']
          });
        } catch (e) {
          // Script might already be injected
        }

        // Wait for script to load
        await delay(500);

        // Send import request to content script
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'PINTEREST_IMPORT_BOARD',
          maxPins: message.maxPins || 2000
        });

        if (!result || !result.success) {
          sendResponse({
            success: false,
            error: result?.error || 'Failed to extract pins'
          });
          return;
        }

        if (result.pins.length === 0) {
          sendResponse({
            success: false,
            error: 'No pins found on this page'
          });
          return;
        }

        // Process and upload pins to Supabase in batches
        const boardName = result.boardInfo?.name || 'Unknown Board';
        const boardUrl = result.boardInfo?.url || tab.url;
        const totalPins = typeof result.stats?.expectedCount === 'number'
          ? result.stats.expectedCount
          : null;

        console.log(`[Pinterest Import] Uploading ${result.pins.length} pins from "${boardName}"`);

        const uploadResult = await uploadPinsToSupabase(
          result.pins,
          boardName,
          boardUrl,
          totalPins
        );

        try {
          fetch('http://localhost:3000/run-embeddings', { method: 'POST' }).catch(error => {
            console.log('[Pinterest Import] Embedding trigger failed:', error);
          });
        } catch (error) {
          console.log('[Pinterest Import] Embedding trigger failed:', error);
        }

        sendResponse({
          success: true,
          pinsExtracted: result.pins.length,
          pinsUploaded: uploadResult.added,
          pinsFailed: uploadResult.failed,
          totalPins: uploadResult.total,
          boardName,
          stats: result.stats
        });

      } catch (error) {
        console.error('[Pinterest Import] Error:', error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Import failed'
        });
      }
    })();
    return true;
  }

  // Handle progress updates from content script
  if (message.type === 'PINTEREST_IMPORT_PROGRESS') {
    const progress = message.progress;
    // Broadcast to any listening sidepanel/popup
    chrome.runtime.sendMessage({
      type: 'PINTEREST_IMPORT_PROGRESS_UPDATE',
      progress
    }).catch(() => {});
    return false; // Sync response
  }

  // Quick import (no scrolling, just what's visible)
  if (message.type === 'PINTEREST_QUICK_IMPORT') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url?.includes('pinterest.com')) {
          sendResponse({ success: false, error: 'Please open a Pinterest page first' });
          return;
        }

        // Inject and extract
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['pinterest_active.js']
          });
        } catch (e) {}

        await delay(300);

        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'PINTEREST_QUICK_EXTRACT'
        });

        if (!result?.pins?.length) {
          sendResponse({ success: false, error: 'No pins found' });
          return;
        }

        const boardName = result.boardInfo?.name || 'Pinterest';
        const boardUrl = result.boardInfo?.url || tab.url;

        const uploadResult = await uploadPinsToSupabase(result.pins, boardName, boardUrl);

        try {
          fetch('http://localhost:3000/run-embeddings', { method: 'POST' }).catch(error => {
            console.log('[Pinterest Import] Embedding trigger failed:', error);
          });
        } catch (error) {
          console.log('[Pinterest Import] Embedding trigger failed:', error);
        }

        sendResponse({
          success: true,
          pinsExtracted: result.pins.length,
          pinsUploaded: uploadResult.added,
          boardName
        });

      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Quick import failed'
        });
      }
    })();
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
    syncChromeBookmarks().then(result => sendResponse({
      success: true,
      count: result.newCount,
      totalCount: result.totalCount
    }));
    return true;
  }

  if (message.type === 'GET_CHROME_BOOKMARK_COUNT') {
    getChromeBookmarkCount().then(count => sendResponse({ count }));
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

  if (message.type === 'GET_PINTEREST_BOARDS_SUPABASE') {
    (async () => {
      try {
        if (!(await isSupabaseConfigured())) {
          sendResponse({ success: false, error: 'Supabase not configured' });
          return;
        }

        const boards = await getPinterestBoards();
        sendResponse({ success: true, boards });
      } catch (error) {
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === 'RESYNC_PINTEREST_BOARD') {
    (async () => {
      try {
        const boardUrl = message.boardUrl as string | undefined;
        const boardName = message.boardName as string | undefined;
        const maxPins = typeof message.maxPins === 'number' ? message.maxPins : 400;

        if (!boardUrl) {
          sendResponse({ success: false, error: 'Missing boardUrl' });
          return;
        }

        if (!(await isSupabaseConfigured())) {
          sendResponse({ success: false, error: 'Supabase not configured' });
          return;
        }

        const tab = await chrome.tabs.create({ url: boardUrl, active: false });
        const tabId = tab.id;
        if (!tabId) {
          sendResponse({ success: false, error: 'Failed to open Pinterest tab' });
          return;
        }

        try {
          await waitForTabLoad(tabId);
          await delay(1000);

          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['pinterest_active.js']
            });
          } catch (error) {
            // Script might already be injected
          }

          await delay(400);

          const pinsResponse = await chrome.tabs.sendMessage(tabId, {
            type: 'PINTEREST_ACTIVE_FETCH_PINS',
            boardUrl,
            maxPins
          });

          const pins = (pinsResponse?.pins || []) as Array<{ pinId: string; title: string; description?: string; imageUrl: string; pinUrl: string }>;
          if (!pins.length) {
            sendResponse({ success: false, error: 'No pins found for this board' });
            return;
          }

          for (const pin of pins) {
            try {
              await processPin({
                pinId: pin.pinId,
                title: pin.title,
                description: pin.description,
                imageUrl: pin.imageUrl,
                pinUrl: pin.pinUrl
              }, boardName || 'Pinterest', boardUrl);
            } catch (error) {
              // Skip duplicates
            }
          }

          const totalPins = typeof pinsResponse?.stats?.expectedCount === 'number'
            ? pinsResponse.stats.expectedCount
            : null;

          const now = new Date().toISOString();
          const payloads: PinterestPinInsert[] = pins
            .map(pin => ({
              pin_id: extractPinId(pin.pinUrl),
              pin_url: pin.pinUrl,
              image_url: pin.imageUrl,
              title: pin.title || '',
              description: pin.description || null,
              board_name: boardName || 'Pinterest',
              board_url: boardUrl,
              created_at: now
            }))
            .filter(pin => isValidSupabasePinPayload(pin));

          const result = await resyncPinterestBoard(boardUrl, payloads, boardName, totalPins ?? null);
          try {
            fetch('http://localhost:3000/run-embeddings', { method: 'POST' }).catch(error => {
              console.log('[Pinterest Resync] Embedding trigger failed:', error);
            });
          } catch (error) {
            console.log('[Pinterest Resync] Embedding trigger failed:', error);
          }
          sendResponse({ success: true, ...result });
        } finally {
          chrome.tabs.remove(tabId).catch(() => undefined);
        }
      } catch (error) {
        sendResponse({ success: false, error: (error as Error).message });
      }
    })();
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
        sendResponse({ ...result, success: true });
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

  if (message.type === 'SYNC_PINTEREST_TO_SUPABASE') {
    syncPinterestPinsToSupabase().then(result => {
      sendResponse(result);
    });
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
