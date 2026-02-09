/**
 * OpenMemory - Background Service Worker
 * Handles side panel, idle-based indexing, metadata fetching, and Pinterest sync
 */

import { db, IndexedBookmark, IndexingQueueItem } from './db';
import {
  checkPinterestLogin,
  scrapePinterestBoards,
  scrapeBoardPins,
  scrollToLoadContent,
  processPin,
  initializePinterestIntegration,
  updatePinterestIntegration,
  getPinterestIntegration,
  ScrapedBoard,
  ScrapedPin,
  ScrapeBoardsResult
} from './pinterest';

// ============== CONSTANTS ==============
const BATCH_SIZE = 5;
const IDLE_THRESHOLD = 60; // seconds
const FETCH_TIMEOUT = 10000; // 10 seconds
const MAX_CONTENT_LENGTH = 500;
const ALARM_NAME = 'checkIndexing';
const ALARM_PERIOD_MINUTES = 5;

// Pinterest sync constants
const PINTEREST_ALARM = 'pinterestSync';
const PINTEREST_SYNC_HOURS = 2;
const BATCH_DELAY_MS = 1200; // 50 pins/min = 1.2s delay

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
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OpenMemory] Browser started');
  await initializePinterestIntegration();
  setupAlarms();
});

function setupAlarms() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  chrome.alarms.create(PINTEREST_ALARM, { periodInMinutes: PINTEREST_SYNC_HOURS * 60 });
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

// Listen for bookmark changes
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (bookmark.url) {
    const existing = await db.bookmarks.where('url').equals(bookmark.url).first();
    if (!existing) {
      // Get parent folder path
      let folderPath = '';
      if (bookmark.parentId) {
        folderPath = await getBookmarkFolderPath(bookmark.parentId);
      }

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
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  // We don't delete from our DB to preserve indexed content
  // User can still search for it
  console.log('[OpenMemory] Bookmark removed (kept in search):', id);
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

async function syncPinterest(providedUsername?: string): Promise<void> {
  if (pinterestSyncInProgress) {
    console.log('[Pinterest] Sync already in progress, skipping...');
    return;
  }

  const { loggedIn, username: detectedUsername } = await checkPinterestLogin();
  const username = providedUsername || detectedUsername;

  if (!loggedIn) {
    console.log('[Pinterest] Not logged in, skipping sync');
    return;
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

  let tabId: number | undefined;

  try {
    // 1. Open tab to Pinterest saved boards (visible so Pinterest renders properly)
    // Navigate directly to the _saved section which shows boards
    const savedUrl = `https://in.pinterest.com/${username}/_saved/`;
    console.log('[Pinterest] Opening saved boards:', savedUrl);

    const tab = await chrome.tabs.create({
      url: savedUrl,
      active: true,  // Make visible - Pinterest may render differently for hidden tabs
      pinned: false
    });

    tabId = tab.id;
    if (!tabId) throw new Error('Failed to create tab');

    // 2. Wait for page load
    console.log('[Pinterest] Waiting for tab to load...');
    await waitForTabLoad(tabId);
    console.log('[Pinterest] Tab loaded, waiting for dynamic content...');
    await delay(8000); // Longer wait for dynamic content

    // 2.5 Scroll to trigger lazy loading
    console.log('[Pinterest] Scrolling to load content...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollToLoadContent
      });
      await delay(2000);
    } catch (e) {
      console.log('[Pinterest] Scroll failed, continuing...', e);
    }

    // 3. Scrape boards
    console.log('[Pinterest] Executing board scraping script...');
    let boardResults;
    try {
      boardResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapePinterestBoards
      });
      console.log('[Pinterest] Board scrape raw results:', boardResults);
    } catch (scriptError) {
      console.error('[Pinterest] Script execution failed:', scriptError);
      throw scriptError;
    }

    const scrapeResult: ScrapeBoardsResult = boardResults[0]?.result || { boards: [], debug: {} };
    console.log('[Pinterest] DEBUG - URL:', scrapeResult.debug?.url);
    console.log('[Pinterest] DEBUG - Username:', scrapeResult.debug?.username);
    console.log('[Pinterest] DEBUG - Total links:', scrapeResult.debug?.totalLinks);
    console.log('[Pinterest] DEBUG - Body length:', scrapeResult.debug?.bodyLength);
    console.log('[Pinterest] DEBUG - User links found:', scrapeResult.debug?.userLinks);
    console.log('[Pinterest] DEBUG - Found in JSON:', scrapeResult.debug?.foundInJson);
    console.log('[Pinterest] DEBUG - JSON boards:', scrapeResult.debug?.jsonBoards);

    const boards: ScrapedBoard[] = scrapeResult.boards || [];
    console.log('[Pinterest] Found', boards.length, 'boards:', boards);

    // If no boards, try "All Pins" or scrape pins from current page
    if (boards.length === 0) {
      console.log('[Pinterest] No boards found, trying _pins or _created...');

      // Try navigating to pins section
      const allPinsUrl = `https://in.pinterest.com/${username}/_created/`;
      await chrome.tabs.update(tabId, { url: allPinsUrl });
      await waitForTabLoad(tabId);
      await delay(3000);

      // Scrape pins directly
      const directPinResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeBoardPins
      });

      const directPins: ScrapedPin[] = directPinResults[0]?.result || [];
      console.log('[Pinterest] Found', directPins.length, 'pins in All Pins');

      if (directPins.length > 0) {
        // Process these pins
        for (const pin of directPins) {
          try {
            await processPin(pin, 'All Pins', allPinsUrl);
            await delay(BATCH_DELAY_MS);
          } catch (error) {
            console.warn('[Pinterest] Failed to process pin:', pin.pinId, error);
          }
        }

        await chrome.tabs.remove(tabId);
        tabId = undefined;

        await updatePinterestIntegration({
          syncStatus: 'idle',
          syncProgress: 100,
          lastSyncAt: Date.now(),
          totalPins: directPins.length
        });

        console.log('[Pinterest] Sync complete. Processed', directPins.length, 'pins');
        return;
      }
    }

    // 4. For each board, scrape pins with throttling
    let processedPins = 0;
    let totalPinsEstimate = boards.length * 25; // Estimate

    for (let i = 0; i < boards.length; i++) {
      const board = boards[i];
      console.log('[Pinterest] Scraping board:', board.name, '->', board.url);

      // Navigate to board
      await chrome.tabs.update(tabId, { url: board.url });
      await waitForTabLoad(tabId);
      await delay(2000);

      // Scroll to load pins
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollToLoadContent
        });
        await delay(1500);
      } catch (e) {
        console.log('[Pinterest] Scroll failed on board, continuing...');
      }

      // Scrape pins from board
      console.log('[Pinterest] Scraping pins from board...');
      const pinResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeBoardPins
      });
      console.log('[Pinterest] Pin scrape results:', pinResults);

      const pins: ScrapedPin[] = pinResults[0]?.result || [];
      console.log('[Pinterest] Found', pins.length, 'pins in', board.name);

      // Process pins with throttling
      for (const pin of pins) {
        try {
          await processPin(pin, board.name, board.url);
          processedPins++;

          // Update progress
          const progress = Math.min(Math.round((processedPins / totalPinsEstimate) * 100), 99);
          await updatePinterestIntegration({ syncProgress: progress });

          // Throttle: 50 pins per minute
          await delay(BATCH_DELAY_MS);
        } catch (error) {
          console.warn('[Pinterest] Failed to process pin:', pin.pinId, error);
        }
      }
    }

    // 5. Close hidden tab
    await chrome.tabs.remove(tabId);
    tabId = undefined;

    // 6. Update integration status
    await updatePinterestIntegration({
      syncStatus: 'idle',
      syncProgress: 100,
      lastSyncAt: Date.now(),
      totalPins: processedPins
    });

    console.log('[Pinterest] Sync complete. Processed', processedPins, 'pins');

  } catch (error) {
    console.error('[Pinterest] Sync failed:', error);
    await updatePinterestIntegration({ syncStatus: 'error' });

    // Clean up tab if it exists
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
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

// ============== MESSAGE HANDLING FOR UI ==============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_INDEXING_STATUS') {
    getIndexingStatus().then(sendResponse);
    return true; // Async response
  }

  if (message.type === 'TRIGGER_INDEXING') {
    processIndexingQueue().then(() => sendResponse({ success: true }));
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
    syncPinterest(username).then(() => sendResponse({ success: true }));
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
