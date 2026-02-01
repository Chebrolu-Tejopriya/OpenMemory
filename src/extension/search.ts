/**
 * OpenMemory - Client-side semantic search
 */

interface BookmarkItem {
  title: string;
  url: string;
  folder: string | null;
  intent?: string;
  score?: number;
}

interface BookmarkData {
  items: BookmarkItem[];
  folders: string[];
}

// DOM Elements
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const loadMoreBtn = document.getElementById('load-more-btn') as HTMLButtonElement;
const suggestionsEl = document.getElementById('suggestions') as HTMLDivElement;
const activeFilterEl = document.getElementById('active-filter') as HTMLDivElement;
const filterTextEl = document.getElementById('filter-text') as HTMLSpanElement;
const removeFilterBtn = document.getElementById('remove-filter') as HTMLSpanElement;
const itemCountEl = document.getElementById('item-count') as HTMLSpanElement;

// State
let allItems: BookmarkItem[] = [];
let allFolders: string[] = [];
let currentResults: BookmarkItem[] = [];
let displayedCount = 0;
let currentFolder: string | null = null;
let selectedSuggestionIndex = -1;
const ITEMS_PER_PAGE = 20;
const MIN_SCORE = 0.3;

// Intent keywords
const INSPIRATION_KEYWORDS = [
  'inspiration', 'inspired', 'ideas', 'design', 'ui', 'ux',
  'visual', 'layout', 'website', 'example', 'gallery', 'showcase',
  'portfolio', 'dribbble', 'behance', 'awwwards', 'beautiful',
  'aesthetic', 'creative', 'stunning', 'elegant', 'minimal',
  'dashboard', 'landing', 'homepage', 'interface', 'mockup'
];

const DEV_KEYWORDS = [
  'node', 'nodejs', 'react', 'vue', 'angular', 'typescript',
  'javascript', 'python', 'backend', 'frontend', 'api', 'database',
  'performance', 'optimization', 'algorithm', 'programming',
  'code', 'coding', 'developer', 'engineering', 'devops'
];

const INSPIRATION_FOLDERS = ['inspiration', 'design', 'ui', 'ux', 'visual', 'creative'];
const DEV_FOLDERS = ['dev', 'development', 'programming', 'code', 'backend'];

// Load data
async function loadData(): Promise<void> {
  try {
    const response = await fetch(chrome.runtime.getURL('data.json'));
    const data: BookmarkData = await response.json();
    allItems = data.items;
    allFolders = data.folders;
    itemCountEl.textContent = `${allItems.length} items`;
    console.log(`Loaded ${allItems.length} bookmarks`);
  } catch (err) {
    console.error('Failed to load data:', err);
    itemCountEl.textContent = 'No data';
    statusEl.textContent = 'Error: Could not load bookmark data';
  }
}

// Check if text contains any keywords
function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// Infer query intent
function inferQueryIntent(query: string): string {
  const lower = query.toLowerCase();
  if (containsAny(lower, INSPIRATION_KEYWORDS)) return 'inspiration';
  if (containsAny(lower, DEV_KEYWORDS)) return 'learning';
  return 'inspiration'; // Default for design tool
}

// Check if item should be excluded
function shouldExclude(queryIntent: string, item: BookmarkItem): boolean {
  if (queryIntent !== 'inspiration') return false;

  const title = item.title.toLowerCase();
  const folder = (item.folder || '').toLowerCase();

  const isDevContent = containsAny(title, DEV_KEYWORDS) || containsAny(folder, DEV_FOLDERS);
  const hasNoDesignSignal = !containsAny(title, INSPIRATION_KEYWORDS) &&
                            !containsAny(folder, INSPIRATION_FOLDERS);

  return isDevContent && hasNoDesignSignal;
}

// Calculate intent score adjustment
function calculateIntentScore(queryIntent: string, item: BookmarkItem): number {
  if (queryIntent !== 'inspiration') return 1.0;

  const title = item.title.toLowerCase();
  const folder = (item.folder || '').toLowerCase();
  let multiplier = 1.0;

  if (item.intent === 'inspiration') multiplier *= 1.5;
  if (containsAny(folder, INSPIRATION_FOLDERS)) multiplier *= 1.3;
  if (containsAny(title, INSPIRATION_KEYWORDS)) multiplier *= 1.2;
  if (containsAny(title, DEV_KEYWORDS)) multiplier *= 0.2;
  if (containsAny(folder, DEV_FOLDERS)) multiplier *= 0.2;

  return multiplier;
}

// Simple text-based search
function textSearch(query: string, items: BookmarkItem[]): BookmarkItem[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  return items
    .map(item => {
      const titleLower = item.title.toLowerCase();
      const folderLower = (item.folder || '').toLowerCase();
      const combined = titleLower + ' ' + folderLower;

      let score = 0;
      for (const word of queryWords) {
        if (combined.includes(word)) score += 0.5;
        if (titleLower.includes(word)) score += 0.3;
      }

      return { ...item, score };
    })
    .filter(item => item.score! > 0)
    .sort((a, b) => b.score! - a.score!);
}

// Search function
function search(query: string): BookmarkItem[] {
  if (!query.trim()) return [];

  const queryIntent = inferQueryIntent(query);
  let results = textSearch(query, allItems);

  // Apply folder filter if set
  if (currentFolder) {
    results = results.filter(item =>
      item.folder && item.folder.toLowerCase().startsWith(currentFolder!.toLowerCase())
    );
  }

  // Apply intent-based filtering and scoring
  results = results
    .filter(item => !shouldExclude(queryIntent, item))
    .map(item => ({
      ...item,
      score: item.score! * calculateIntentScore(queryIntent, item)
    }))
    .filter(item => item.score! >= MIN_SCORE)
    .sort((a, b) => b.score! - a.score!);

  return results;
}

// Render functions
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatPath(folder: string): string {
  if (!folder) return '';
  return folder.split('/').map(p => escapeHtml(p)).join('<span>/</span>');
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
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
  // Using 11ty screenshot service - same as backend
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}

function renderCard(item: BookmarkItem): string {
  const faviconUrl = getFaviconUrl(item.url);
  const screenshotUrl = getScreenshotUrl(item.url);
  return `
    <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="card">
      <div class="card-thumbnail">
        <div class="placeholder">
          <img class="placeholder-favicon" src="${faviconUrl}" alt="">
        </div>
        <img class="card-screenshot loading" src="${screenshotUrl}" alt="">
      </div>
      <div class="card-content">
        <div class="card-title">${escapeHtml(item.title)}</div>
        ${item.folder ? `<div class="card-path">${formatPath(item.folder)}</div>` : ''}
        <div class="card-meta">
          <span class="source-badge">Chrome</span>
        </div>
      </div>
    </a>
  `;
}

function renderResults(results: BookmarkItem[], append = false): void {
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

// Folder suggestions
function showSuggestions(filter: string): void {
  const filtered = allFolders
    .filter(f => f.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 8);

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

// Search execution
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

// Event listeners
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

// Handle image load/error via event delegation (CSP compliant)
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

// Initialize
loadData();
