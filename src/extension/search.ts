/**
 * OpenMemory - Client-side search with MiniSearch
 * Full-text search with field weighting and snippet generation
 * Includes Pinterest pins integration
 */

import MiniSearch from 'minisearch';
import { db, IndexedBookmark, PinterestPin } from './db';

// ============== INTERFACES ==============
type SearchableItem = (IndexedBookmark & { source: 'chrome' }) | (PinterestPin & { source: 'pinterest' });

interface SearchResult {
  item: SearchableItem;
  score: number;
  matchField: 'title' | 'folder' | 'extendedContent' | 'boardName';
  snippet?: string;
}

interface SearchableDocument {
  id: string; // Changed to string to handle composite IDs
  title: string;
  url: string;
  folder: string;
  extendedContent: string;
  contentType: string;
  source: 'chrome' | 'pinterest';
}

// ============== DOM ELEMENTS ==============
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const loadMoreBtn = document.getElementById('load-more-btn') as HTMLButtonElement;
const suggestionsEl = document.getElementById('suggestions') as HTMLDivElement;
const activeFilterEl = document.getElementById('active-filter') as HTMLDivElement;
const filterTextEl = document.getElementById('filter-text') as HTMLSpanElement;
const removeFilterBtn = document.getElementById('remove-filter') as HTMLSpanElement;
const itemCountEl = document.getElementById('item-count') as HTMLSpanElement;

// Integrations UI elements
const integrationsToggle = document.getElementById('integrations-toggle') as HTMLButtonElement;
const integrationsSection = document.getElementById('integrations-section') as HTMLDivElement;
const closeIntegrations = document.getElementById('close-integrations') as HTMLButtonElement;
const pinterestStatus = document.getElementById('pinterest-status') as HTMLDivElement;
const pinterestConnect = document.getElementById('pinterest-connect') as HTMLButtonElement;
const pinterestProgress = document.getElementById('pinterest-progress') as HTMLDivElement;
const pinterestProgressFill = document.getElementById('pinterest-progress-fill') as HTMLDivElement;
const pinterestProgressText = document.getElementById('pinterest-progress-text') as HTMLDivElement;
const bookmarksStatus = document.getElementById('bookmarks-status') as HTMLDivElement;
const bookmarksSync = document.getElementById('bookmarks-sync') as HTMLButtonElement;

// ============== STATE ==============
let allItems: SearchableItem[] = [];
let allFolders: string[] = [];
let miniSearch: MiniSearch<SearchableDocument> | null = null;
let currentResults: SearchResult[] = [];
let displayedCount = 0;
let currentFolder: string | null = null;
let selectedSuggestionIndex = -1;
const ITEMS_PER_PAGE = 20;

// Object URL cache for Pinterest images
const blobUrlCache = new Map<string, string>();

// ============== INITIALIZATION ==============
async function initializeSearch(): Promise<void> {
  try {
    // Load bookmarks from IndexedDB
    const [bookmarks, pins] = await Promise.all([
      db.bookmarks.toArray(),
      db.pins.toArray()
    ]);

    // Mark sources and combine
    const bookmarkItems: SearchableItem[] = bookmarks.map(b => ({ ...b, source: 'chrome' as const }));
    const pinItems: SearchableItem[] = pins.map(p => ({ ...p, source: 'pinterest' as const }));

    allItems = [...bookmarkItems, ...pinItems];

    // If no bookmarks, try fallback to data.json
    if (bookmarks.length === 0) {
      console.log('[OpenMemory] Loading from data.json...');
      try {
        const response = await fetch(chrome.runtime.getURL('data.json'));
        if (response.ok) {
          const data = await response.json();
          const jsonItems: SearchableItem[] = (data.items || []).map((item: any) => ({
            ...item,
            indexStatus: 'pending' as const,
            source: 'chrome' as const
          }));
          allItems = [...jsonItems, ...pinItems];
          allFolders = data.folders || [];
        }
      } catch (fetchError) {
        console.warn('[OpenMemory] Could not load data.json:', fetchError);
      }
    }

    // Extract unique folders from bookmarks
    if (allFolders.length === 0) {
      const folderSet = new Set<string>();
      allItems.forEach(item => {
        if (item.source === 'chrome' && item.folder) {
          folderSet.add(item.folder);
        }
      });
      allFolders = Array.from(folderSet).sort();
    }

    // Initialize MiniSearch
    initializeMiniSearch();

    const pinsCount = pins.length;
    const bookmarksCount = bookmarks.length || allItems.filter(i => i.source === 'chrome').length;
    itemCountEl.textContent = pinsCount > 0
      ? `${bookmarksCount} bookmarks, ${pinsCount} pins`
      : `${allItems.length} items`;

    console.log(`[OpenMemory] Loaded ${bookmarksCount} bookmarks, ${pinsCount} pins`);

    // Update indexing status display
    updateIndexingStatus();
  } catch (err) {
    console.error('[OpenMemory] Failed to load data:', err);
    itemCountEl.textContent = 'No data';
    statusEl.textContent = 'Error: Could not load bookmark data';
  }
}

function initializeMiniSearch(): void {
  miniSearch = new MiniSearch<SearchableDocument>({
    fields: ['title', 'folder', 'extendedContent'],
    storeFields: ['title', 'url', 'folder', 'extendedContent', 'contentType', 'source'],
    searchOptions: {
      boost: {
        title: 3,
        folder: 1.5,
        extendedContent: 1
      },
      fuzzy: 0.2,
      prefix: true
    },
    idField: 'id'
  });

  const documents: SearchableDocument[] = allItems.map((item, index) => {
    if (item.source === 'pinterest') {
      return {
        id: `pin_${item.pinId}`,
        title: item.title || '',
        url: item.pinUrl || '',
        folder: item.boardName || '', // Use boardName as folder for searching
        extendedContent: item.description || '',
        contentType: 'pinterest',
        source: 'pinterest' as const
      };
    } else {
      return {
        id: `bm_${item.id ?? index}`,
        title: item.title || '',
        url: item.url || '',
        folder: item.folder || '',
        extendedContent: item.extendedContent || '',
        contentType: item.contentType || '',
        source: 'chrome' as const
      };
    }
  });

  miniSearch.addAll(documents);
  console.log('[OpenMemory] MiniSearch index built with', documents.length, 'documents');
}

async function updateIndexingStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_INDEXING_STATUS' });
    if (response && response.indexed > 0) {
      const percent = Math.round((response.indexed / response.total) * 100);
      if (percent < 100) {
        itemCountEl.textContent = `${allItems.length} items (${percent}% indexed)`;
      }
    }
  } catch (err) {
    // Background might not be ready, ignore
  }
}

// ============== SEARCH FUNCTION ==============
function search(query: string): SearchResult[] {
  if (!query.trim() || !miniSearch) return [];

  // Check for special blog/article queries
  const isBlogQuery = /\b(blog|article|post|journal)\b/i.test(query);
  const isPinterestQuery = /\b(pin|pinterest|board)\b/i.test(query);

  // Perform MiniSearch
  const results = miniSearch.search(query);

  // Map to SearchResult with additional metadata
  let searchResults: SearchResult[] = [];

  for (const result of results) {
    // Find item by composite ID
    const resultId = result.id as string;
    let item: SearchableItem | undefined;

    if (resultId.startsWith('pin_')) {
      const pinId = resultId.substring(4);
      item = allItems.find(i => i.source === 'pinterest' && i.pinId === pinId) as SearchableItem | undefined;
    } else if (resultId.startsWith('bm_')) {
      const bmId = parseInt(resultId.substring(3), 10);
      item = allItems.find((i, idx) => i.source === 'chrome' && (i.id ?? idx) === bmId) as SearchableItem | undefined;
    }

    if (!item) continue;

    const matchField = determineMatchField(query, item);
    let snippet: string | undefined;

    if (item.source === 'chrome' && matchField === 'extendedContent') {
      snippet = generateSnippet(item.extendedContent || '', query);
    } else if (item.source === 'pinterest' && item.description) {
      snippet = generateSnippet(item.description, query);
    }

    searchResults.push({
      item,
      score: result.score,
      matchField,
      snippet
    });
  }

  // Boost blog content for blog queries
  if (isBlogQuery) {
    searchResults = searchResults.map(r => ({
      ...r,
      score: r.item.source === 'chrome' && r.item.contentType === 'blog' ? r.score * 2 : r.score
    }));
    searchResults.sort((a, b) => b.score - a.score);
  }

  // Boost Pinterest content for pinterest queries
  if (isPinterestQuery) {
    searchResults = searchResults.map(r => ({
      ...r,
      score: r.item.source === 'pinterest' ? r.score * 2 : r.score
    }));
    searchResults.sort((a, b) => b.score - a.score);
  }

  // Apply folder filter if set
  if (currentFolder) {
    searchResults = searchResults.filter(r => {
      if (r.item.source === 'chrome') {
        return r.item.folder?.toLowerCase().startsWith(currentFolder!.toLowerCase());
      } else {
        return r.item.boardName?.toLowerCase().startsWith(currentFolder!.toLowerCase());
      }
    });
  }

  return searchResults;
}

function determineMatchField(query: string, item: SearchableItem): 'title' | 'folder' | 'extendedContent' | 'boardName' {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  // Check if any query word matches title
  for (const word of queryWords) {
    if (item.title.toLowerCase().includes(word)) return 'title';
  }

  // Check folder/boardName
  if (item.source === 'chrome') {
    for (const word of queryWords) {
      if (item.folder?.toLowerCase().includes(word)) return 'folder';
    }
  } else {
    for (const word of queryWords) {
      if (item.boardName?.toLowerCase().includes(word)) return 'boardName';
    }
  }

  return 'extendedContent';
}

function generateSnippet(content: string, query: string): string {
  if (!content) return '';

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  const contentLower = content.toLowerCase();

  // Find the first matching word
  let matchIndex = -1;
  for (const word of queryWords) {
    const idx = contentLower.indexOf(word);
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }

  if (matchIndex === -1) {
    return content.substring(0, 120) + (content.length > 120 ? '...' : '');
  }

  // Extract surrounding context
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(content.length, matchIndex + 80);

  let snippet = content.substring(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// ============== RENDERING ==============
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatPath(folder: string): string {
  if (!folder) return '';
  return folder.split('/').map(p => escapeHtml(p)).join('<span>/</span>');
}

function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return '';
  }
}

function getScreenshotUrl(url: string): string {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}

function highlightQuery(text: string, query: string): string {
  if (!query || !text) return text;
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let result = text;
  for (const word of words) {
    const regex = new RegExp(`(${escapeRegExp(word)})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }
  return result;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderCard(result: SearchResult): string {
  const { item, snippet } = result;

  if (item.source === 'pinterest') {
    return renderPinterestCard(item, snippet);
  }

  return renderBookmarkCard(item, snippet);
}

function renderBookmarkCard(item: IndexedBookmark & { source: 'chrome' }, snippet?: string): string {
  const faviconUrl = getFaviconUrl(item.url);
  const screenshotUrl = getScreenshotUrl(item.url);

  // Blog badge
  const blogBadge = item.contentType === 'blog'
    ? '<span class="blog-badge">Blog</span>'
    : '';

  // Snippet HTML (only for extendedContent matches)
  const snippetHtml = snippet
    ? `<div class="card-snippet">${highlightQuery(escapeHtml(snippet), searchInput.value)}</div>`
    : '';

  return `
    <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="card">
      <div class="card-thumbnail">
        <div class="placeholder">
          <img class="placeholder-favicon" src="${faviconUrl}" alt="">
        </div>
        <img class="card-screenshot loading" src="${screenshotUrl}" alt="">
      </div>
      <div class="card-content">
        <div class="card-title">
          <span class="card-title-text">${escapeHtml(item.title)}</span>
          ${blogBadge}
        </div>
        ${item.folder ? `<div class="card-path">${formatPath(item.folder)}</div>` : ''}
        ${snippetHtml}
        <div class="card-meta">
          <span class="source-badge">Chrome</span>
        </div>
      </div>
    </a>
  `;
}

function renderPinterestCard(item: PinterestPin & { source: 'pinterest' }, snippet?: string): string {
  // Use stored WebP blob or original URL
  let imageUrl = item.originalImageUrl;

  if (item.imageBlob) {
    // Check cache first
    const cacheKey = item.pinId;
    if (blobUrlCache.has(cacheKey)) {
      imageUrl = blobUrlCache.get(cacheKey)!;
    } else {
      const blobUrl = URL.createObjectURL(item.imageBlob);
      blobUrlCache.set(cacheKey, blobUrl);
      imageUrl = blobUrl;
    }
  }

  const snippetHtml = snippet
    ? `<div class="card-snippet">${highlightQuery(escapeHtml(snippet), searchInput.value)}</div>`
    : '';

  const titleText = item.title || 'Pinterest Pin';

  return `
    <a href="${escapeHtml(item.pinUrl)}" target="_blank" rel="noopener" class="card pinterest">
      <div class="card-thumbnail">
        <div class="placeholder">
          <div class="pinterest-placeholder-icon">P</div>
        </div>
        <img class="card-screenshot loading" src="${escapeHtml(imageUrl)}" alt="">
        <div class="pinterest-icon">
          <svg viewBox="0 0 24 24" width="12" height="12">
            <path fill="#ffffff" d="M12 0C5.4 0 0 5.4 0 12c0 5.1 3.2 9.4 7.6 11.2-.1-.9-.2-2.4 0-3.4.2-.9 1.4-6 1.4-6s-.4-.7-.4-1.8c0-1.7 1-2.9 2.2-2.9 1 0 1.5.8 1.5 1.7 0 1-.7 2.6-1 4-.3 1.2.6 2.2 1.8 2.2 2.1 0 3.8-2.2 3.8-5.5 0-2.9-2.1-4.9-5-4.9-3.4 0-5.4 2.6-5.4 5.2 0 1 .4 2.1.9 2.7.1.1.1.2.1.3-.1.4-.3 1.2-.3 1.4-.1.2-.2.3-.4.2-1.5-.7-2.4-2.9-2.4-4.6 0-3.8 2.8-7.3 8-7.3 4.2 0 7.5 3 7.5 7 0 4.2-2.6 7.5-6.3 7.5-1.2 0-2.4-.6-2.8-1.4l-.8 3c-.3 1.1-.9 2.2-1.4 3 1 .3 2.1.5 3.3.5 6.6 0 12-5.4 12-12S18.6 0 12 0z"/>
          </svg>
        </div>
      </div>
      <div class="card-content">
        <div class="card-title">
          <span class="card-title-text">${escapeHtml(titleText)}</span>
        </div>
        <div class="card-path">Pinterest<span>/</span>${escapeHtml(item.boardName)}</div>
        ${snippetHtml}
        <div class="card-meta">
          <span class="source-badge pinterest">Pinterest</span>
        </div>
      </div>
    </a>
  `;
}

function renderResults(results: SearchResult[], append = false): void {
  if (results.length === 0 && !append) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <h2>No inspirations found</h2>
        <p>Try a different search term</p>
      </div>
    `;
    loadMoreBtn.style.display = 'none';
    return;
  }

  const html = results.map(renderCard).join('');
  if (append) {
    resultsEl.insertAdjacentHTML('beforeend', html);
  } else {
    resultsEl.innerHTML = html;
  }
}

// ============== FOLDER SUGGESTIONS ==============
function showSuggestions(filter: string): void {
  const filtered = allFolders
    .filter(f => f.toLowerCase().includes(filter.toLowerCase()));

  if (filtered.length === 0) {
    hideSuggestions();
    return;
  }

  selectedSuggestionIndex = -1;
  suggestionsEl.innerHTML = filtered.map((folder, i) => `
    <div class="suggestion-item" data-folder="${escapeHtml(folder)}" data-index="${i}">
      📁 ${escapeHtml(folder)}
    </div>
  `).join('');
  suggestionsEl.classList.add('active');
}

function hideSuggestions(): void {
  suggestionsEl.classList.remove('active');
  selectedSuggestionIndex = -1;
}

function selectFolder(folder: string): void {
  currentFolder = folder;
  filterTextEl.textContent = `📁 ${folder}`;
  activeFilterEl.style.display = 'inline-flex';

  const value = searchInput.value;
  const atIndex = value.lastIndexOf('@');
  if (atIndex !== -1) {
    searchInput.value = value.substring(0, atIndex).trim();
  }

  hideSuggestions();
  searchInput.focus();

  if (searchInput.value.trim()) {
    performSearch();
  }
}

function clearFilter(): void {
  currentFolder = null;
  activeFilterEl.style.display = 'none';
  if (searchInput.value.trim()) {
    performSearch();
  }
}

// ============== SEARCH EXECUTION ==============
function performSearch(): void {
  const query = searchInput.value.trim();
  if (!query) {
    resultsEl.innerHTML = '';
    statusEl.textContent = '';
    loadMoreBtn.style.display = 'none';
    return;
  }

  currentResults = search(query);
  displayedCount = 0;

  const filterInfo = currentFolder ? ` in ${currentFolder}` : '';
  statusEl.textContent = `${currentResults.length} inspirations found${filterInfo}`;

  showMore();
}

function showMore(): void {
  const toShow = currentResults.slice(displayedCount, displayedCount + ITEMS_PER_PAGE);
  renderResults(toShow, displayedCount > 0);
  displayedCount += toShow.length;

  if (displayedCount < currentResults.length) {
    loadMoreBtn.style.display = 'block';
    loadMoreBtn.textContent = `Load more (${currentResults.length - displayedCount} remaining)`;
  } else {
    loadMoreBtn.style.display = 'none';
  }
}

// ============== EVENT LISTENERS ==============
removeFilterBtn.addEventListener('click', clearFilter);

suggestionsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest('.suggestion-item') as HTMLElement;
  if (item) selectFolder(item.dataset.folder!);
});

loadMoreBtn.addEventListener('click', showMore);

searchInput.addEventListener('keydown', (e) => {
  if (!suggestionsEl.classList.contains('active')) return;

  const items = suggestionsEl.querySelectorAll('.suggestion-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, items.length - 1);
    items.forEach((item, i) => item.classList.toggle('selected', i === selectedSuggestionIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, 0);
    items.forEach((item, i) => item.classList.toggle('selected', i === selectedSuggestionIndex));
  } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
    e.preventDefault();
    selectFolder((items[selectedSuggestionIndex] as HTMLElement).dataset.folder!);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

let debounceTimer: number;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const value = searchInput.value;

  const atIndex = value.lastIndexOf('@');
  if (atIndex !== -1) {
    showSuggestions(value.substring(atIndex + 1));
    return;
  } else {
    hideSuggestions();
  }

  debounceTimer = window.setTimeout(performSearch, 150);
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('.search-wrapper')) {
    hideSuggestions();
  }
});

// Handle image load/error via event delegation
resultsEl.addEventListener('load', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('card-screenshot')) {
    target.classList.remove('loading');
    target.classList.add('loaded');
    const placeholder = target.parentElement?.querySelector('.placeholder') as HTMLElement;
    if (placeholder) placeholder.style.display = 'none';
  }
}, true);

resultsEl.addEventListener('error', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('card-screenshot')) {
    target.style.display = 'none';
  } else if (target.classList.contains('placeholder-favicon')) {
    target.style.visibility = 'hidden';
  }
}, true);

// ============== INTEGRATIONS UI ==============
let pinterestPollingInterval: number | null = null;

integrationsToggle.addEventListener('click', () => {
  integrationsSection.classList.toggle('active');
  if (integrationsSection.classList.contains('active')) {
    updatePinterestUI();
  }
});

closeIntegrations.addEventListener('click', () => {
  integrationsSection.classList.remove('active');
});

pinterestConnect.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest connect clicked');

  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });
    console.log('[OpenMemory] Pinterest status:', status);

    if (status?.connected && status?.syncStatus !== 'syncing') {
      // Disconnect
      if (confirm('Disconnect Pinterest and remove synced pins?')) {
        await chrome.runtime.sendMessage({ type: 'DISCONNECT_PINTEREST' });
        updatePinterestUI();
        await initializeSearch();
      }
    } else if (status?.syncStatus === 'syncing') {
      // Already syncing
      console.log('[OpenMemory] Already syncing');
    } else {
      // Check if logged in to Pinterest
      const loginStatus = await chrome.runtime.sendMessage({ type: 'CHECK_PINTEREST_LOGIN' });
      console.log('[OpenMemory] Pinterest login status:', loginStatus);

      if (loginStatus?.loggedIn) {
        // Ask for username if not available
        let username = loginStatus.username;
        if (!username) {
          username = prompt('Enter your Pinterest username:');
          if (!username) {
            alert('Username is required to sync your boards.');
            return;
          }
        }

        // Start sync with username
        pinterestStatus.textContent = 'Starting sync...';
        pinterestStatus.className = 'integration-status syncing';
        pinterestConnect.textContent = 'Syncing...';
        pinterestConnect.className = 'connect-btn syncing';

        chrome.runtime.sendMessage({ type: 'TRIGGER_PINTEREST_SYNC', username });
        startPinterestPolling();
      } else {
        // Open Pinterest login
        chrome.tabs.create({ url: 'https://www.pinterest.com/login/' });
        alert('Please log in to Pinterest in the opened tab, then click Connect again.');
      }
    }
  } catch (error) {
    console.error('[OpenMemory] Pinterest connect error:', error);
    alert('Error connecting to Pinterest. Check the console for details.');
  }
});

async function updatePinterestUI(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });

    if (!status) {
      pinterestStatus.textContent = 'Not connected';
      pinterestStatus.className = 'integration-status';
      pinterestConnect.textContent = 'Connect';
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      return;
    }

    if (status.syncStatus === 'syncing') {
      pinterestStatus.textContent = `Syncing...`;
      pinterestStatus.className = 'integration-status syncing';
      pinterestConnect.textContent = 'Syncing...';
      pinterestConnect.className = 'connect-btn syncing';
      pinterestProgress.classList.add('active');
      pinterestProgressFill.style.width = `${status.syncProgress || 0}%`;
      pinterestProgressText.textContent = `Syncing pins... ${status.syncProgress || 0}%`;
      integrationsToggle.classList.add('has-connection');
      startPinterestPolling();
    } else if (status.connected) {
      const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleDateString() : 'Never';
      const pinCount = status.totalPins || 0;
      pinterestStatus.textContent = `${status.username || 'Connected'} - ${pinCount} pins (Last: ${lastSync})`;
      pinterestStatus.className = 'integration-status connected';
      pinterestConnect.textContent = 'Disconnect';
      pinterestConnect.className = 'connect-btn connected';
      pinterestProgress.classList.remove('active');
      integrationsToggle.classList.add('has-connection');
      stopPinterestPolling();
    } else if (status.syncStatus === 'error') {
      pinterestStatus.textContent = 'Sync failed - try again';
      pinterestStatus.className = 'integration-status error';
      pinterestConnect.textContent = 'Retry';
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    } else {
      pinterestStatus.textContent = 'Not connected';
      pinterestStatus.className = 'integration-status';
      pinterestConnect.textContent = 'Connect';
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    }
  } catch (err) {
    console.error('[OpenMemory] Failed to get Pinterest status:', err);
  }
}

function startPinterestPolling(): void {
  if (pinterestPollingInterval) return;

  pinterestPollingInterval = window.setInterval(async () => {
    await updatePinterestUI();

    // Check if sync completed
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });
    if (status?.syncStatus !== 'syncing') {
      stopPinterestPolling();
      // Refresh search data after sync completes
      await initializeSearch();
    }
  }, 2000);
}

function stopPinterestPolling(): void {
  if (pinterestPollingInterval) {
    clearInterval(pinterestPollingInterval);
    pinterestPollingInterval = null;
  }
}

// Check Pinterest status on load
updatePinterestUI();

// ============== BOOKMARKS UI ==============
bookmarksSync.addEventListener('click', async () => {
  bookmarksSync.textContent = 'Syncing...';
  bookmarksSync.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_CHROME_BOOKMARKS' });
    if (result?.count > 0) {
      bookmarksStatus.textContent = `Synced ${result.count} new bookmarks`;
      // Refresh search data
      await initializeSearch();
    } else {
      bookmarksStatus.textContent = 'Already up to date';
    }
  } catch (err) {
    console.error('[OpenMemory] Bookmark sync failed:', err);
    bookmarksStatus.textContent = 'Sync failed';
  }

  bookmarksSync.textContent = 'Sync';
  bookmarksSync.disabled = false;

  // Update count after a moment
  setTimeout(updateBookmarksUI, 1000);
});

async function updateBookmarksUI(): Promise<void> {
  try {
    const bookmarkCount = allItems.filter(i => i.source === 'chrome').length;
    const response = await chrome.runtime.sendMessage({ type: 'GET_INDEXING_STATUS' });

    if (response) {
      const percent = response.total > 0 ? Math.round((response.indexed / response.total) * 100) : 0;
      bookmarksStatus.textContent = `${response.total} bookmarks (${percent}% indexed)`;
    } else {
      bookmarksStatus.textContent = `${bookmarkCount} bookmarks`;
    }
  } catch {
    const bookmarkCount = allItems.filter(i => i.source === 'chrome').length;
    bookmarksStatus.textContent = `${bookmarkCount} bookmarks`;
  }
}

// Update bookmarks UI on load
setTimeout(updateBookmarksUI, 500);

// ============== INITIALIZE ==============
initializeSearch();
