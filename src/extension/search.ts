/**
 * OpenMemory - Hybrid Search with MiniSearch + Supabase AI
 * Full-text search with field weighting and snippet generation
 * Includes Pinterest pins integration and Supabase semantic search
 */

import MiniSearch from 'minisearch';
import { db, IndexedBookmark, PinterestPin } from './db';

// ============== SUPABASE SEARCH ==============
interface SupabaseBookmark {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  chrome_id: string | null;
  similarity: number;
}

interface SupabaseSearchResult {
  source: 'chrome' | 'pinterest';
  item_id: string;
  url: string;
  title: string;
  folder_or_board: string | null;
  image_url: string | null;
  similarity: number;
}

async function getSupabaseConfig(): Promise<{ url: string; anonKey: string } | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], (result) => {
      if (result.supabaseUrl && result.supabaseAnonKey) {
        resolve({ url: result.supabaseUrl, anonKey: result.supabaseAnonKey });
      } else {
        resolve(null);
      }
    });
  });
}

// Generate embedding via Supabase Edge Function (uses HF with token)
async function generateLocalEmbedding(text: string): Promise<number[] | null> {
  const config = await getSupabaseConfig();
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
      console.error('[Search] Embedding API error:', response.status);
      return null;
    }

    const result = await response.json();
    return Array.isArray(result.embedding) ? result.embedding : null;
  } catch (error) {
    console.error('[Search] Embedding failed:', error);
    return null;
  }
}

// Search using vector similarity (semantic search) - includes both bookmarks AND Pinterest pins
async function searchSupabaseVector(query: string, limit = 50, folder?: string): Promise<SupabaseSearchResult[]> {
  const config = await getSupabaseConfig();
  if (!config) return [];

  try {
    // Generate embedding locally
    const embedding = await generateLocalEmbedding(query);
    if (!embedding) {
      console.log('[Search] No embedding, falling back to text search');
      const bookmarkResults = await searchSupabaseText(query, limit, folder);
      // Convert to unified format
      return bookmarkResults.map(b => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: b.similarity
      }));
    }

    // Use combined search that includes both bookmarks and Pinterest pins
    const response = await fetch(`${config.url}/rest/v1/rpc/search_all_items`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: limit,
        filter_folder: folder || null
      })
    });

    if (!response.ok) {
      console.log('[Search] Combined vector search failed, falling back to text');
      const bookmarkResults = await searchSupabaseText(query, limit, folder);
      return bookmarkResults.map(b => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: b.similarity
      }));
    }

    const results = await response.json();

    // If no vector results, fall back to text search
    if (!results || results.length === 0) {
      const bookmarkResults = await searchSupabaseText(query, limit, folder);
      return bookmarkResults.map(b => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: b.similarity
      }));
    }

    return results;
  } catch (error) {
    console.error('[Search] Vector search error:', error);
    const bookmarkResults = await searchSupabaseText(query, limit, folder);
    return bookmarkResults.map(b => ({
      source: 'chrome' as const,
      item_id: b.id,
      url: b.url,
      title: b.title,
      folder_or_board: b.folder,
      image_url: null,
      similarity: b.similarity
    }));
  }
}

// Fallback text search
async function searchSupabaseText(query: string, limit = 50, folder?: string): Promise<SupabaseBookmark[]> {
  const config = await getSupabaseConfig();
  if (!config) return [];

  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/search_bookmarks_text`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        search_query: query,
        match_count: limit,
        filter_folder: folder || null
      })
    });

    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

// Main search function - uses vector search with text fallback
async function searchSupabase(query: string, limit = 50, folder?: string): Promise<SupabaseSearchResult[]> {
  return searchSupabaseVector(query, limit, folder);
}

// ============== HYBRID SEARCH ==============
interface HybridResult {
  url: string;
  title: string;
  folder: string | null;
  keywordScore: number;  // Score from MiniSearch (0-1 normalized)
  semanticScore: number; // Score from vector search (0-1)
  combinedScore: number; // Weighted combination
  source: 'chrome' | 'pinterest';
  item?: SearchableItem;
}

async function hybridSearch(query: string, limit = 50, folder?: string): Promise<HybridResult[]> {
  const resultMap = new Map<string, HybridResult>();

  // Run local MiniSearch and Supabase search in parallel
  const [localResults, supabaseResults] = await Promise.all([
    Promise.resolve(search(query)), // Local MiniSearch
    isSupabaseAvailable ? searchSupabase(query, limit, folder) : Promise.resolve([])
  ]);

  // Normalize MiniSearch scores (they can be > 1)
  const maxLocalScore = Math.max(...localResults.map(r => r.score), 1);

  // Add local results to map
  for (const result of localResults) {
    const url = result.item.source === 'chrome' ? result.item.url : result.item.pinUrl;
    const normalizedScore = result.score / maxLocalScore;

    resultMap.set(url, {
      url,
      title: result.item.title,
      folder: result.item.source === 'chrome' ? result.item.folder || null : result.item.boardName || null,
      keywordScore: normalizedScore,
      semanticScore: 0,
      combinedScore: normalizedScore * 0.6, // Keyword weight: 60%
      source: result.item.source,
      item: result.item
    });
  }

  // Add/merge Supabase results (now includes both bookmarks AND Pinterest pins)
  for (const result of supabaseResults) {
    const existing = resultMap.get(result.url);
    const semanticScore = result.similarity || 0;

    if (existing) {
      // Found in both - boost the score!
      existing.semanticScore = semanticScore;
      existing.combinedScore = (existing.keywordScore * 0.5) + (semanticScore * 0.5) + 0.2; // Bonus for appearing in both
    } else {
      // Only in semantic search - could be bookmark or Pinterest pin
      resultMap.set(result.url, {
        url: result.url,
        title: result.title,
        folder: result.folder_or_board,
        keywordScore: 0,
        semanticScore: semanticScore,
        combinedScore: semanticScore * 0.4, // Semantic weight: 40%
        source: result.source, // 'chrome' or 'pinterest'
        item: undefined
      });
    }
  }

  // Sort by combined score and return top results
  const sorted = Array.from(resultMap.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);

  // Apply folder filter if set
  if (folder) {
    return sorted.filter(r => r.folder?.toLowerCase().startsWith(folder.toLowerCase()));
  }

  return sorted;
}

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
const pinterestReset = document.getElementById('pinterest-reset') as HTMLButtonElement;
const pinterestProgress = document.getElementById('pinterest-progress') as HTMLDivElement;
const pinterestProgressFill = document.getElementById('pinterest-progress-fill') as HTMLDivElement;
const pinterestProgressText = document.getElementById('pinterest-progress-text') as HTMLDivElement;
const pinterestSyncStats = document.getElementById('pinterest-sync-stats') as HTMLDivElement;
const pinterestBoardTotal = document.getElementById('pinterest-board-total') as HTMLDivElement;
const pinterestBoardUpdated = document.getElementById('pinterest-board-updated') as HTMLDivElement;
const pinterestBoardArchived = document.getElementById('pinterest-board-archived') as HTMLDivElement;
const pinterestDeepSync = document.getElementById('pinterest-deep-sync') as HTMLInputElement;
if (pinterestDeepSync) {
  pinterestDeepSync.checked = true;
}
const bookmarksStatus = document.getElementById('bookmarks-status') as HTMLDivElement;
const bookmarksSync = document.getElementById('bookmarks-sync') as HTMLButtonElement;

// Board selection elements
const boardSelection = document.getElementById('board-selection') as HTMLDivElement;
const closeBoardSelection = document.getElementById('close-board-selection') as HTMLButtonElement;
const boardCount = document.getElementById('board-count') as HTMLSpanElement;
const boardList = document.getElementById('board-list') as HTMLDivElement;
const selectAllBoards = document.getElementById('select-all-boards') as HTMLButtonElement;
const syncSelectedBoards = document.getElementById('sync-selected-boards') as HTMLButtonElement;

// Pinterest Import elements
const pinterestImportBtn = document.getElementById('pinterest-import-current') as HTMLButtonElement;
const pinterestResyncBtn = document.getElementById('pinterest-resync-current') as HTMLButtonElement;
const pinterestImportProgress = document.getElementById('pinterest-import-progress') as HTMLDivElement;
const pinterestImportProgressFill = document.getElementById('pinterest-import-progress-fill') as HTMLDivElement;
const pinterestImportStatus = document.getElementById('pinterest-import-status') as HTMLDivElement;
const pinterestImportResult = document.getElementById('pinterest-import-result') as HTMLDivElement;
const pinterestBoardsSection = document.getElementById('pinterest-boards-section') as HTMLDivElement;
const pinterestBoardsList = document.getElementById('pinterest-boards-list') as HTMLDivElement;
const pinterestBoardsMessage = document.getElementById('pinterest-boards-message') as HTMLDivElement;

interface DiscoveredBoard {
  name: string;
  url: string;
}

let discoveredBoards: DiscoveredBoard[] = [];
let discoveredUsername: string | null = null;

interface PinterestBoardRow {
  board_name: string | null;
  board_url: string;
  total_pins: number | null;
  imported_pins: number | null;
  last_synced_at: string | null;
}

// ============== STATE ==============
let allItems: SearchableItem[] = [];
let allFolders: string[] = [];
let miniSearch: MiniSearch<SearchableDocument> | null = null;
let currentResults: SearchResult[] = [];
let displayedCount = 0;
let currentFolder: string | null = null;
let selectedSuggestionIndex = -1;
const ITEMS_PER_PAGE = 20;

// Supabase availability flag
let isSupabaseAvailable = false;

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
    
    // Update count display
    if (pinsCount > 0 && bookmarksCount > 0) {
      itemCountEl.textContent = `${bookmarksCount} 📚 ${pinsCount} 📌`;
    } else if (pinsCount > 0) {
      itemCountEl.textContent = `${pinsCount} pins`;
    } else {
      itemCountEl.textContent = `${bookmarksCount} items`;
    }

    console.log(`[OpenMemory] Loaded ${bookmarksCount} bookmarks, ${pinsCount} pins`);

    // Auto-trigger indexing silently in background
    const queueCount = await db.queue.count();
    if (queueCount > 0) {
      console.log(`[OpenMemory] Auto-indexing ${queueCount} items in background...`);
      chrome.runtime.sendMessage({ type: 'TRIGGER_INDEXING' });
    }
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
  // Indexing happens automatically in background - no need to show progress
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

// ============== SEARCH MODE UI ==============
function updateSearchModeUI(): void {
  // Hide the toggle button - we use unified smart search now
  const toggleBtn = document.getElementById('search-mode-toggle');
  if (toggleBtn) {
    toggleBtn.style.display = 'none';
  }
}

// ============== SEARCH EXECUTION ==============
let isSearching = false;

async function performSearch(): Promise<void> {
  const query = searchInput.value.trim();
  if (!query) {
    resultsEl.innerHTML = '';
    statusEl.textContent = '';
    loadMoreBtn.style.display = 'none';
    return;
  }

  // Prevent concurrent searches
  if (isSearching) return;
  isSearching = true;

  const filterInfo = currentFolder ? ` in ${currentFolder}` : '';

  try {
    if (isSupabaseAvailable) {
      // Smart Search: Keywords + AI combined (like Google)
      statusEl.textContent = `Searching...`;

      const hybridResults = await hybridSearch(query, 50, currentFolder || undefined);

      // Convert hybrid results to SearchResult format
      currentResults = hybridResults.map(r => ({
        item: r.item || {
          id: undefined,
          url: r.url,
          title: r.title,
          folder: r.folder,
          indexStatus: 'indexed' as const,
          source: r.source
        } as SearchableItem,
        score: r.combinedScore,
        matchField: r.keywordScore > 0 ? 'title' as const : 'extendedContent' as const,
        snippet: undefined
      }));

      statusEl.textContent = `${currentResults.length} results found${filterInfo}`;

    } else {
      // Local MiniSearch only (Supabase not configured)
      currentResults = search(query);
      statusEl.textContent = `${currentResults.length} results found${filterInfo}`;
    }
  } catch (error) {
    console.error('[OpenMemory] Search failed:', error);
    // Fallback to local search on error
    currentResults = search(query);
    statusEl.textContent = `${currentResults.length} results found${filterInfo}`;
  }

  displayedCount = 0;
  isSearching = false;
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
    updatePinterestBoardsUI();
  }
});

closeIntegrations.addEventListener('click', () => {
  integrationsSection.classList.remove('active');
});

// Close board selection
closeBoardSelection.addEventListener('click', () => {
  boardSelection.classList.remove('active');
});

function setPinterestCtaText(text: string): void {
  pinterestConnect.textContent = text || 'Sync Pinterest';
}

pinterestConnect.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest connect clicked');

  try {
    await openPinterestActiveSync();
  } catch (error) {
    console.error('[OpenMemory] Pinterest connect error:', error);
    alert('Error connecting to Pinterest. Check the console for details.');
  }
});

// ============== PINTEREST IMPORT CURRENT BOARD ==============
pinterestImportBtn?.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest import current board clicked');

  // Reset UI
  pinterestImportResult.style.display = 'none';
  pinterestImportProgress.style.display = 'block';
  pinterestImportProgressFill.style.width = '0%';
  pinterestImportStatus.textContent = 'Starting import...';
  pinterestImportStatus.style.color = '#fbbf24';
  pinterestImportBtn.disabled = true;
  pinterestImportBtn.textContent = 'Importing...';

  try {
    const deepSync = pinterestDeepSync?.checked ?? true;
    const maxPins = deepSync ? 2000 : 1200;
    const result = await chrome.runtime.sendMessage({
      type: 'PINTEREST_IMPORT_CURRENT_BOARD',
      maxPins
    });

    pinterestImportProgress.style.display = 'none';

    if (result?.success) {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(74, 222, 128, 0.1)';
      pinterestImportResult.style.color = '#4ade80';
      pinterestImportResult.innerHTML = `
        <strong>Import successful!</strong><br>
        Board: ${result.boardName || 'Unknown'}<br>
        Pins extracted: ${result.pinsExtracted}<br>
        Pins uploaded: ${result.pinsUploaded}
        ${result.pinsFailed > 0 ? `<br>Failed: ${result.pinsFailed}` : ''}
      `;

      // Refresh the search data
      await initializeSearch();
      updatePinterestUI();
    } else {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
      pinterestImportResult.style.color = '#f87171';
      pinterestImportResult.textContent = result?.error || 'Import failed';
    }
  } catch (error) {
    console.error('[OpenMemory] Pinterest import error:', error);
    pinterestImportProgress.style.display = 'none';
    pinterestImportResult.style.display = 'block';
    pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
    pinterestImportResult.style.color = '#f87171';
    pinterestImportResult.textContent = error instanceof Error ? error.message : 'Import failed';
  } finally {
    pinterestImportBtn.disabled = false;
    pinterestImportBtn.textContent = 'Import';
  }
});

// Listen for import progress updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PINTEREST_IMPORT_PROGRESS_UPDATE' && message.progress) {
    const { status, pinsCollected, message: statusMessage } = message.progress;

    if (pinterestImportProgress.style.display !== 'none') {
      const percent = Math.min(95, pinsCollected / 3); // Rough estimate
      pinterestImportProgressFill.style.width = `${percent}%`;
      pinterestImportStatus.textContent = statusMessage || `Importing... ${pinsCollected} pins`;

      if (status === 'complete') {
        pinterestImportProgressFill.style.width = '100%';
        pinterestImportStatus.style.color = '#4ade80';
      } else if (status === 'error') {
        pinterestImportStatus.style.color = '#f87171';
      }
    }
  }
});

async function openPinterestActiveSync(): Promise<void> {
  const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });

  if (status?.syncStatus === 'syncing') {
    console.log('[OpenMemory] Already syncing');
    return;
  }

  // Check if logged in first
  const loginStatus = await chrome.runtime.sendMessage({ type: 'CHECK_PINTEREST_LOGIN' });
  if (!loginStatus?.loggedIn) {
    // Open Pinterest to let user log in
    const tab = await chrome.tabs.create({ url: 'https://www.pinterest.com/login/', active: true });
    alert('Please log in to Pinterest, then click the sync button again.');
    return;
  }

  const stored = await chrome.storage.local.get('pinterestUsername');
  let username = stored?.pinterestUsername as string | undefined;

  if (!username) {
    const manualUsername = prompt(
      'Please enter your Pinterest username to sync:\n' +
      '(You can find it in your Pinterest profile URL: pinterest.com/YOUR_USERNAME)'
    );

    if (!manualUsername || manualUsername.trim() === '') {
      return;
    }

    username = manualUsername.trim();
    await chrome.storage.local.set({ pinterestUsername: username });
  }

  const deepSync = pinterestDeepSync?.checked ?? true;
  if (deepSync) {
    setPinterestCtaText('Syncing...');
    pinterestStatus.textContent = 'Syncing (deep)...';
    pinterestStatus.className = 'integration-status syncing';
    pinterestProgress.classList.add('active');

    console.log('[OpenMemory] Starting deep Pinterest sync for:', username);
    chrome.runtime.sendMessage({ type: 'TRIGGER_PINTEREST_SYNC', username, deepSync: true });
    startPinterestPolling();
    return;
  }

  // Fast sync (API-based, fewer pins)
  setPinterestCtaText('Syncing...');
  pinterestStatus.textContent = 'Syncing via API...';
  pinterestStatus.className = 'integration-status syncing';
  pinterestProgress.classList.add('active');

  console.log('[OpenMemory] Starting fast Pinterest sync for:', username);
  chrome.runtime.sendMessage({ type: 'FAST_PINTEREST_SYNC', username });
  startPinterestPolling();
}

// Function to discover boards and show selection UI
async function discoverAndShowBoards(): Promise<void> {
  pinterestStatus.textContent = 'Checking Pinterest login...';
  pinterestStatus.className = 'integration-status syncing';
  pinterestConnect.textContent = 'Connecting...';
  pinterestConnect.className = 'connect-btn syncing';
  integrationsSection.classList.add('active');

  try {
    // First check if logged in
    const loginStatus = await chrome.runtime.sendMessage({ type: 'CHECK_PINTEREST_LOGIN' });

    if (!loginStatus?.loggedIn) {
      alert('Please log in to Pinterest in your browser first, then try again.');
      updatePinterestUI();
      return;
    }

    pinterestStatus.textContent = 'Extracting username...';

    let manualEntryUsed = false;

    // Discover boards - username will be auto-extracted if not provided
    let result = await chrome.runtime.sendMessage({
      type: 'DISCOVER_PINTEREST_BOARDS'
      // No username needed - will be auto-extracted
    });

    // If auto-extraction failed, ask user for their username
    if (!result || result.loggedOut) {
      alert('Please log in to Pinterest in your browser first, then try again.');
      updatePinterestUI();
      return;
    }

    if (!result.username) {
      const manualUsername = prompt(
        'Could not detect your Pinterest username automatically.\n\n' +
        'Please enter your Pinterest username:\n' +
        '(You can find it in your Pinterest profile URL: pinterest.com/YOUR_USERNAME)'
      );

      if (!manualUsername || manualUsername.trim() === '') {
        alert('Username is required to connect Pinterest.');
        updatePinterestUI();
        return;
      }

      const manualValue = manualUsername.trim();
      manualEntryUsed = true;
      await chrome.storage.local.set({ pinterestUsername: manualValue });

      // Retry with manual username
      pinterestStatus.textContent = `Discovering boards for @${manualValue}...`;
      result = await chrome.runtime.sendMessage({
        type: 'DISCOVER_PINTEREST_BOARDS',
        username: manualValue
      });
    }

    if (!result) {
      alert('Could not connect to Pinterest. Make sure you are logged in.');
      updatePinterestUI();
      return;
    }

    if (!result.boards || result.boards.length === 0) {
      alert(`Connected as ${result.username}, but no boards found. Create some boards on Pinterest first.`);
      updatePinterestUI();
      return;
    }

    discoveredBoards = result.boards;
    discoveredUsername = result.username;
    boardCount.textContent = discoveredBoards.length.toString();

    // Render board list with checkboxes
    boardList.innerHTML = discoveredBoards.map((board, index) => `
      <label class="board-item">
        <input type="checkbox" data-index="${index}" checked>
        <span>${board.name}</span>
      </label>
    `).join('');

    // Show board selection
    boardSelection.classList.add('active');
    pinterestStatus.textContent = `@${result.username} - ${discoveredBoards.length} boards found`;
    pinterestConnect.textContent = 'Select Boards';
    pinterestConnect.className = 'connect-btn';

    // If user manually entered username, auto-trigger sync for all boards
    if (manualEntryUsed) {
      await chrome.runtime.sendMessage({
        type: 'TRIGGER_PINTEREST_SYNC',
        username: result.username,
        boards: discoveredBoards
      });
      startPinterestPolling();
    }

  } catch (error) {
    console.error('[OpenMemory] Board discovery failed:', error);
    alert('Failed to discover boards. Check console for details.');
    updatePinterestUI();
  }
}

// Select all boards
selectAllBoards.addEventListener('click', () => {
  const checkboxes = boardList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  checkboxes.forEach(cb => cb.checked = !allChecked);
});

// Sync selected boards
syncSelectedBoards.addEventListener('click', async () => {
  const checkboxes = boardList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index || '0'));
  const selectedBoards = selectedIndices.map(i => discoveredBoards[i]);

  if (selectedBoards.length === 0) {
    alert('Please select at least one board to sync.');
    return;
  }

  // Use the username discovered earlier
  if (!discoveredUsername) {
    alert('Could not get Pinterest username. Please try connecting again.');
    updatePinterestUI();
    return;
  }

  console.log('[OpenMemory] Syncing', selectedBoards.length, 'selected boards for user:', discoveredUsername);

  // Hide board selection
  boardSelection.classList.remove('active');

  // Update UI for syncing
  pinterestStatus.textContent = `Syncing ${selectedBoards.length} boards...`;
  pinterestStatus.className = 'integration-status syncing';
  pinterestConnect.textContent = 'Syncing...';
  pinterestConnect.className = 'connect-btn syncing';
  pinterestProgress.classList.add('active');
  pinterestSyncStats.classList.add('active');
  pinterestBoardTotal.textContent = `Boards: ${selectedBoards.length}`;
  pinterestBoardUpdated.textContent = 'Updated: 0';
  pinterestBoardArchived.textContent = 'Archived: 0';

  // Start sync with selected boards
  await chrome.runtime.sendMessage({
    type: 'TRIGGER_PINTEREST_SYNC',
    username: discoveredUsername,
    boards: selectedBoards
  });

  startPinterestPolling();
});

async function updatePinterestUI(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });
    const pins = await chrome.runtime.sendMessage({ type: 'GET_ALL_PINS' });
    const existingPinCount = pins?.length || 0;

    if (!status) {
      if (existingPinCount > 0) {
        pinterestStatus.textContent = `${existingPinCount} pins synced`;
        pinterestStatus.className = 'integration-status';
        } else {
          pinterestStatus.textContent = 'Not connected';
          pinterestStatus.className = 'integration-status';
        }
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
        pinterestProgress.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      await updatePinterestBoardsUI();
      return;
    }

      if (status.syncStatus === 'syncing') {
      pinterestStatus.textContent = `Syncing...`;
      pinterestStatus.className = 'integration-status syncing';
      setPinterestCtaText('Syncing...');
      pinterestConnect.className = 'connect-btn syncing';
      pinterestProgress.classList.add('active');
      pinterestProgressFill.style.width = `${status.syncProgress || 0}%`;
      if (!status.syncProgress) {
  pinterestProgressText.textContent = 'Syncing boards... please wait';
  setPinterestCtaText('Sync Pinterest');
      } else {
        pinterestProgressText.textContent = `Syncing pins... ${status.syncProgress || 0}%`;
      }
      pinterestSyncStats.classList.add('active');
      pinterestBoardTotal.textContent = `Boards: ${status.boardTotal ?? 0}`;
      pinterestBoardUpdated.textContent = `Updated: ${status.boardUpdated ?? 0}`;
      pinterestBoardArchived.textContent = `Archived: ${status.boardArchived ?? 0}`;
      integrationsToggle.classList.add('has-connection');
      startPinterestPolling();
    } else if (status.connected) {
      const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleDateString() : 'Never';
      const pinCount = status.totalPins || 0;
      pinterestStatus.textContent = `${status.username || 'Connected'} - ${pinCount} pins (Last: ${lastSync})`;
      pinterestStatus.className = 'integration-status connected';
      setPinterestCtaText('Sync Pinterest');
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.add('active');
      pinterestBoardTotal.textContent = `Boards: ${status.boardTotal ?? 0}`;
      pinterestBoardUpdated.textContent = `Updated: ${status.boardUpdated ?? 0}`;
      pinterestBoardArchived.textContent = `Archived: ${status.boardArchived ?? 0}`;
      integrationsToggle.classList.add('has-connection');
      stopPinterestPolling();
    } else if (status.syncStatus === 'error') {
      pinterestStatus.textContent = 'Sync failed - try again';
      pinterestStatus.className = 'integration-status error';
      setPinterestCtaText('Sync Pinterest');
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    } else {
      // Not connected - check if pins exist
      if (existingPinCount > 0) {
        pinterestStatus.textContent = `${existingPinCount} pins synced (connect to continue)`;
        pinterestStatus.className = 'integration-status';
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
      } else {
        pinterestStatus.textContent = 'Not connected';
        pinterestStatus.className = 'integration-status';
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
      }
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    }
    await updatePinterestBoardsUI();
  } catch (err) {
    console.error('[OpenMemory] Failed to get Pinterest status:', err);
  }
}

async function updatePinterestBoardsUI(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_BOARDS_SUPABASE' });
    if (!response?.success || !Array.isArray(response.boards)) {
      pinterestBoardsSection.style.display = 'block';
      pinterestBoardsList.innerHTML = '';
      pinterestBoardsMessage.textContent = response?.error
        ? response.error
        : 'No boards imported yet';
      pinterestBoardsMessage.style.color = '#fbbf24';
      pinterestBoardsMessage.style.display = 'block';
      return;
    }

    const boards = response.boards as PinterestBoardRow[];
    if (boards.length === 0) {
      pinterestBoardsSection.style.display = 'block';
      pinterestBoardsList.innerHTML = '';
      pinterestBoardsMessage.textContent = 'No boards imported yet';
      pinterestBoardsMessage.style.color = '#fbbf24';
      pinterestBoardsMessage.style.display = 'block';
      return;
    }

    pinterestBoardsSection.style.display = 'block';
    pinterestBoardsMessage.style.display = 'none';
    pinterestBoardsMessage.style.color = '#4ade80';
    pinterestBoardsList.innerHTML = boards.map((board) => {
      const lastSynced = board.last_synced_at
        ? formatRelativeTime(board.last_synced_at)
        : 'Never';
      const totalPins = typeof board.total_pins === 'number' ? board.total_pins : '-';
      const importedPins = typeof board.imported_pins === 'number' ? board.imported_pins : 0;
      const encodedBoardUrl = encodeURIComponent(board.board_url);
      const encodedBoardName = encodeURIComponent(board.board_name || 'Pinterest');

      return `
        <div class="board-row" data-board-url="${encodedBoardUrl}">
          <div class="board-meta">
            <div class="board-name" title="${escapeHtml(board.board_name || 'Untitled')}">${escapeHtml(board.board_name || 'Untitled')}</div>
            <div class="board-stats">Total: ${totalPins}</div>
            <div class="board-stats">Imported: ${importedPins}</div>
            <div class="board-sync">Last synced: ${escapeHtml(lastSynced)}</div>
          </div>
          <div class="board-action">
            <button class="resync-btn" data-board-url="${encodedBoardUrl}" data-board-name="${encodedBoardName}">Resync</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    pinterestBoardsSection.style.display = 'block';
    pinterestBoardsList.innerHTML = '';
    pinterestBoardsMessage.textContent = 'Failed to load boards';
    pinterestBoardsMessage.style.color = '#fbbf24';
    pinterestBoardsMessage.style.display = 'block';
  }
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = Math.max(0, now - then);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

pinterestBoardsList?.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest('.resync-btn') as HTMLButtonElement | null;
  if (!button) return;

  const boardUrl = button.dataset.boardUrl ? decodeURIComponent(button.dataset.boardUrl) : undefined;
  const boardName = button.dataset.boardName ? decodeURIComponent(button.dataset.boardName) : 'Pinterest';
  if (!boardUrl) return;

  button.disabled = true;
  button.textContent = 'Resyncing...';
  pinterestBoardsMessage.style.display = 'none';

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'RESYNC_PINTEREST_BOARD',
      boardUrl,
      boardName
    });

    if (result?.success) {
      pinterestBoardsMessage.textContent = `Added ${result.added} new pins`;
      pinterestBoardsMessage.style.color = '#4ade80';
      pinterestBoardsMessage.style.display = 'block';
      await initializeSearch();
      await updatePinterestBoardsUI();
    } else {
      pinterestBoardsMessage.textContent = result?.error || 'Resync failed';
      pinterestBoardsMessage.style.color = '#f87171';
      pinterestBoardsMessage.style.display = 'block';
    }
  } catch (error) {
    pinterestBoardsMessage.textContent = error instanceof Error ? error.message : 'Resync failed';
    pinterestBoardsMessage.style.color = '#f87171';
    pinterestBoardsMessage.style.display = 'block';
  } finally {
    button.disabled = false;
    button.textContent = 'Resync';
  }
});

// ============== PINTEREST EMBEDDINGS BACKFILL ==============

// ============== PINTEREST RESYNC CURRENT BOARD ==============
pinterestResyncBtn?.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest resync current board clicked');

  pinterestImportResult.style.display = 'none';
  pinterestImportProgress.style.display = 'block';
  pinterestImportProgressFill.style.width = '0%';
  pinterestImportStatus.textContent = 'Resyncing board...';
  pinterestImportStatus.style.color = '#fbbf24';
  pinterestResyncBtn.disabled = true;
  pinterestResyncBtn.textContent = 'Resyncing...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.includes('pinterest.com')) {
      throw new Error('Please open a Pinterest board page first');
    }

    const result = await chrome.runtime.sendMessage({
      type: 'RESYNC_PINTEREST_BOARD',
      boardUrl: tab.url
    });

    pinterestImportProgress.style.display = 'none';

    if (result?.success) {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(74, 222, 128, 0.1)';
      pinterestImportResult.style.color = '#4ade80';
      pinterestImportResult.innerHTML = `
        <strong>Resync complete!</strong><br>
        Added ${result.added} new pins<br>
        Total stored: ${result.total}
      `;

      await initializeSearch();
      updatePinterestUI();
    } else {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
      pinterestImportResult.style.color = '#f87171';
      pinterestImportResult.textContent = result?.error || 'Resync failed';
    }
  } catch (error) {
    pinterestImportProgress.style.display = 'none';
    pinterestImportResult.style.display = 'block';
    pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
    pinterestImportResult.style.color = '#f87171';
    pinterestImportResult.textContent = error instanceof Error ? error.message : 'Resync failed';
  } finally {
    pinterestResyncBtn.disabled = false;
    pinterestResyncBtn.textContent = 'Resync';
  }
});

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

// Pinterest reset button - clears all pins and checkpoints for fresh sync
pinterestReset.addEventListener('click', async () => {
  if (confirm('This will delete all synced Pinterest pins and start fresh. Continue?')) {
    try {
      await chrome.runtime.sendMessage({ type: 'RESET_PINTEREST_SYNC' });
      await initializeSearch();
      updatePinterestUI();
      alert('Pinterest sync has been reset. Click Connect to start fresh.');
    } catch (err) {
      console.error('[OpenMemory] Reset failed:', err);
      alert('Failed to reset Pinterest sync.');
    }
  }
});

// Check Pinterest status on load
updatePinterestUI();

// ============== INDEXING TRIGGER ==============

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
      bookmarksStatus.textContent = `${result?.totalCount || 0} bookmarks - up to date`;
    }
    // Update count display
    await updateBookmarksUI();
  } catch (err) {
    console.error('[OpenMemory] Bookmark sync failed:', err);
    bookmarksStatus.textContent = 'Sync failed';
  }

  bookmarksSync.textContent = 'Sync';
  bookmarksSync.disabled = false;
});

async function updateBookmarksUI(): Promise<void> {
  try {
    // Get actual Chrome bookmark count (not local DB count)
    const result = await chrome.runtime.sendMessage({ type: 'GET_CHROME_BOOKMARK_COUNT' });
    const chromeCount = result?.count || 0;
    bookmarksStatus.textContent = `${chromeCount} bookmarks`;

    // Also update the main count display
    const pinsCount = allItems.filter(i => i.source === 'pinterest').length;
    if (pinsCount > 0 && chromeCount > 0) {
      itemCountEl.textContent = `${chromeCount} 📚 ${pinsCount} 📌`;
    } else if (pinsCount > 0) {
      itemCountEl.textContent = `${pinsCount} pins`;
    } else {
      itemCountEl.textContent = `${chromeCount} items`;
    }
  } catch (err) {
    // Fallback to local count
    const bookmarkCount = allItems.filter(i => i.source === 'chrome').length;
    bookmarksStatus.textContent = `${bookmarkCount} bookmarks`;
  }
}

// Update bookmarks UI on load
setTimeout(updateBookmarksUI, 500);

// ============== SUPABASE SETTINGS UI ==============
const supabaseCard = document.getElementById('supabase-card');
const supabaseStatus = document.getElementById('supabase-status');
const supabaseToggleSettings = document.getElementById('supabase-toggle-settings');
const supabaseSettings = document.getElementById('supabase-settings');
const supabaseUrlInput = document.getElementById('supabase-url') as HTMLInputElement;
const supabaseKeyInput = document.getElementById('supabase-key') as HTMLInputElement;
const supabaseSaveBtn = document.getElementById('supabase-save');
const supabaseCancelBtn = document.getElementById('supabase-cancel');

async function updateSupabaseUI(): Promise<void> {
  const config = await getSupabaseConfig();
  if (config) {
    supabaseStatus!.textContent = 'Connected - AI Search enabled';
    supabaseStatus!.className = 'integration-status connected';
    supabaseToggleSettings!.textContent = 'Edit';
    supabaseUrlInput!.value = config.url;
    supabaseKeyInput!.value = config.anonKey;
    isSupabaseAvailable = true;
  } else {
    supabaseStatus!.textContent = 'Not configured';
    supabaseStatus!.className = 'integration-status';
    supabaseToggleSettings!.textContent = 'Configure';
    isSupabaseAvailable = false;
  }
  updateSearchModeUI();
}

supabaseToggleSettings?.addEventListener('click', () => {
  const isVisible = supabaseSettings!.style.display !== 'none';
  supabaseSettings!.style.display = isVisible ? 'none' : 'block';
  supabaseToggleSettings!.textContent = isVisible ? (isSupabaseAvailable ? 'Edit' : 'Configure') : 'Hide';
});

supabaseCancelBtn?.addEventListener('click', () => {
  supabaseSettings!.style.display = 'none';
  supabaseToggleSettings!.textContent = isSupabaseAvailable ? 'Edit' : 'Configure';
});

supabaseSaveBtn?.addEventListener('click', async () => {
  const url = supabaseUrlInput!.value.trim();
  const key = supabaseKeyInput!.value.trim();

  if (!url || !key) {
    alert('Please enter both URL and Anon Key');
    return;
  }

  if (!url.startsWith('https://') || !url.includes('.supabase.co')) {
    alert('Invalid Supabase URL. Should be like: https://xxx.supabase.co');
    return;
  }

  if (!key.startsWith('eyJ')) {
    alert('Invalid Anon Key. Should start with eyJ...');
    return;
  }

  // Save to storage
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ supabaseUrl: url, supabaseAnonKey: key }, () => {
      resolve();
    });
  });

  // Update UI
  supabaseSettings!.style.display = 'none';
  await updateSupabaseUI();

  alert('Supabase configured! AI Search is now available.');
});


// ============== INITIALIZE ==============
initializeSearch();

// Check Supabase availability and update UI
updateSupabaseUI();
