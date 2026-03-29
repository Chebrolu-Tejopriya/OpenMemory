/**
 * Pinterest Active Tab Content Script
 * Handles pin extraction with progress tracking, efficient scrolling, and robust extraction
 */

// ============== TYPES ==============
interface ExtractedPin {
  pinId: string;
  title: string;
  description?: string;
  imageUrl: string;
  pinUrl: string;
  source: 'pinterest';
  type: 'image';
}

interface ExtractionProgress {
  status: 'extracting' | 'scrolling' | 'complete' | 'error';
  pinsCollected: number;
  scrollCount: number;
  message: string;
}

interface ExtractionResult {
  success: boolean;
  pins: ExtractedPin[];
  error?: string;
  stats: {
    totalFound: number;
    expectedCount: number | null;
    syncComplete: boolean;
    fromApi: number;
    fromDom: number;
    duplicatesRemoved: number;
    invalidRemoved: number;
    scrollsPerformed: number;
    retryAttempts: number;
    timeMs: number;
  };
}

interface BoardInfo {
  boardId?: string;
  name: string;
  url: string;
  pinCount?: number;
}

// ============== CONSTANTS ==============
const SCROLL_WAIT_MS = 2500; // Wait 2.5 seconds after each scroll for content to load
const MAX_SCROLLS = 500; // High limit
const MAX_PINS = 5000; // High max pins
const STABLE_HEIGHT_ITERATIONS = 4; // Stop after page height unchanged for 4 iterations
const SCROLL_UP_AMOUNT = 500; // Pixels to scroll up before scrolling down again

// ============== STATE ==============
let isExtracting = false;
let progressCallback: ((progress: ExtractionProgress) => void) | null = null;

// ============== NETWORK INTERCEPTION STATE ==============
// Store pins captured from API responses
const apiCapturedPins: Map<string, ExtractedPin> = new Map();
let networkInterceptionActive = false;

// ============== NETWORK INTERCEPTION ==============
/**
 * Parse Pinterest API response and extract pin objects
 */
function extractPinsFromApiResponse(data: any): ExtractedPin[] {
  const pins: ExtractedPin[] = [];

  const extractPin = (obj: any): ExtractedPin | null => {
    if (!obj || typeof obj !== 'object') return null;

    // Check if this looks like a pin object
    const id = obj.id;
    const images = obj.images;

    if (!id || !images) return null;

    // Get the best image URL
    const imageUrl = images.orig?.url ||
      images['736x']?.url ||
      images['564x']?.url ||
      images['474x']?.url ||
      images['236x']?.url;

    if (!imageUrl) return null;

    return {
      pinId: String(id),
      title: obj.title || obj.grid_title || obj.description || '',
      description: obj.description || obj.closeup_description || '',
      imageUrl: imageUrl,
      pinUrl: obj.link || `https://www.pinterest.com/pin/${id}/`,
      source: 'pinterest',
      type: 'image'
    };
  };

  const traverse = (obj: any, depth = 0): void => {
    if (!obj || typeof obj !== 'object' || depth > 20) return;

    // Check if this is a pin object
    const pin = extractPin(obj);
    if (pin) {
      pins.push(pin);
      return; // Don't recurse into pin objects
    }

    // Traverse arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        traverse(item, depth + 1);
      }
    } else {
      for (const value of Object.values(obj)) {
        traverse(value, depth + 1);
      }
    }
  };

  // Common locations for pins in Pinterest API responses
  if (data?.resource_response?.data) {
    traverse(data.resource_response.data);
  }
  if (data?.resource?.data) {
    traverse(data.resource.data);
  }
  if (data?.data) {
    traverse(data.data);
  }
  // Also traverse the whole response in case pins are elsewhere
  traverse(data);

  return pins;
}

/**
 * Process intercepted API response
 */
function processApiResponse(url: string, responseText: string): void {
  try {
    const data = JSON.parse(responseText);
    const pins = extractPinsFromApiResponse(data);

    if (pins.length > 0) {
      let newCount = 0;
      for (const pin of pins) {
        if (!apiCapturedPins.has(pin.pinId)) {
          apiCapturedPins.set(pin.pinId, pin);
          newCount++;
        }
      }
      if (newCount > 0) {
        console.log(`[Pinterest API] Captured ${newCount} new pins from ${url.substring(0, 80)}... (total: ${apiCapturedPins.size})`);
      }
    }
  } catch (e) {
    // Ignore parse errors - not all responses are JSON
  }
}

/**
 * Set up network interception to capture Pinterest API responses
 */
function setupNetworkInterception(): void {
  if (networkInterceptionActive) return;
  networkInterceptionActive = true;

  console.log('[Pinterest] Setting up network interception...');

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;

      // Check if this is a Pinterest resource request
      if (url.includes('/resource/') || url.includes('pinterest.com/resource')) {
        // Clone response to read body without consuming it
        const clone = response.clone();
        clone.text().then(text => {
          processApiResponse(url, text);
        }).catch(() => { });
      }
    } catch (e) {
      // Ignore errors
    }

    return response;
  };

  // Intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any)._pinterestUrl = url.toString();
    return originalXHROpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    const url = (xhr as any)._pinterestUrl || '';

    if (url.includes('/resource/') || url.includes('pinterest.com/resource')) {
      xhr.addEventListener('load', function () {
        try {
          if (xhr.responseText) {
            processApiResponse(url, xhr.responseText);
          }
        } catch (e) {
          // Ignore errors
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };

  console.log('[Pinterest] Network interception active');
}

/**
 * Get all pins captured from API
 */
function getApiCapturedPins(): ExtractedPin[] {
  return Array.from(apiCapturedPins.values());
}

/**
 * Clear captured API pins
 */
function clearApiCapturedPins(): void {
  apiCapturedPins.clear();
}

// Set up interception immediately when script loads
setupNetworkInterception();

// ============== UTILITY FUNCTIONS ==============
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:')) return false; // Skip base64
  if (url.includes('placeholder')) return false;
  try {
    new URL(url.startsWith('//') ? `https:${url}` : url);
    return true;
  } catch {
    return false;
  }
}

function normalizeImageUrl(url: string): string {
  if (!url) return '';
  // Convert protocol-relative URLs
  if (url.startsWith('//')) {
    url = `https:${url}`;
  }
  // Get highest quality image by replacing size indicators
  url = url.replace(/\/\d+x\d*\//, '/originals/');
  url = url.replace(/\/\d+x(?:\/|$)/, '/originals/');
  return url.trim();
}

function normalizePinUrl(url: string, pinId: string): string {
  if (url && isValidUrl(url)) {
    return url.startsWith('http') ? url : `${location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  return `${location.origin}/pin/${pinId}/`;
}

function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ').substring(0, 500);
}

// ============== PWS DATA EXTRACTION ==============
function getPwsData(): any | null {
  const el = document.getElementById('__PWS_DATA__');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

function extractFromPwsData(seenIds: Set<string>): ExtractedPin[] {
  const pins: ExtractedPin[] = [];
  const json = getPwsData();
  if (!json) return pins;

  const collectPins = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(collectPins);
      return;
    }

    // Check if this looks like a pin object
    const pinId = obj?.id;
    const images = obj?.images;

    if (pinId && images && !seenIds.has(String(pinId))) {
      const imageUrl = images?.orig?.url || images?.['736x']?.url || images?.['474x']?.url;

      if (imageUrl && isValidUrl(imageUrl)) {
        seenIds.add(String(pinId));
        pins.push({
          pinId: String(pinId),
          title: cleanText(obj?.title || obj?.grid_title),
          description: cleanText(obj?.description),
          imageUrl: normalizeImageUrl(imageUrl),
          pinUrl: normalizePinUrl(obj?.link || '', pinId),
          source: 'pinterest',
          type: 'image'
        });
      }
    }

    // Recursively search
    Object.values(obj).forEach(collectPins);
  };

  // Search in common locations
  collectPins(json?.props?.initialReduxState?.pins);
  collectPins(json?.props?.initialReduxState?.resourceResponses);
  collectPins(json?.props?.initialReduxState?.feeds);

  return pins;
}

// ============== DOM EXTRACTION ==============
/**
 * Extract pins from DOM using anchor elements with /pin/ in href
 * This handles Pinterest's virtualized DOM by extracting what's currently visible
 * @param collectedPinIds - Global Set to track collected pin IDs across scrolls
 * @param resultsArray - Array to push new pins to (persists across scrolls)
 * @returns Number of NEW pins extracted in this call
 */
function extractFromDomIncremental(
  collectedPinIds: Set<string>,
  resultsArray: ExtractedPin[]
): number {
  let newPinsCount = 0;

  // IMPORTANT: Use anchor elements containing "/pin/" - this is the most reliable selector
  const pinAnchors = document.querySelectorAll('a[href*="/pin/"]');

  pinAnchors.forEach(anchor => {
    try {
      const href = (anchor as HTMLAnchorElement).getAttribute('href') || '';
      const pinIdMatch = href.match(/\/pin\/(\d+)/);
      if (!pinIdMatch) return;

      const pinId = pinIdMatch[1];

      // Check if we already collected this pin (use pin ID for deduplication)
      if (collectedPinIds.has(pinId)) return;

      // Find image - check multiple locations
      let img: HTMLImageElement | null = null;
      let src = '';

      // 1. Try inside the anchor
      img = anchor.querySelector('img') as HTMLImageElement;

      // 2. Try in parent container (Pinterest often wraps pins in divs)
      if (!img) {
        const parent = anchor.closest('[data-test-id="pin"]') ||
                       anchor.closest('[data-test-id="pinWrapper"]') ||
                       anchor.closest('[data-grid-item]') ||
                       anchor.parentElement?.parentElement;
        if (parent) {
          img = parent.querySelector('img') as HTMLImageElement;
        }
      }

      // 3. Try sibling elements
      if (!img && anchor.parentElement) {
        img = anchor.parentElement.querySelector('img') as HTMLImageElement;
      }

      if (img) {
        src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      }

      // Even if no valid image yet, still track the pin ID
      // Pinterest lazy-loads images, so we'll update the image URL later if needed
      if (!isValidUrl(src)) {
        // Still add the pin without image - we'll try to get the image on next scroll
        // But only if we haven't seen this pin ID before
        collectedPinIds.add(pinId);
        resultsArray.push({
          pinId,
          title: cleanText(img?.alt || ''),
          description: undefined,
          imageUrl: '', // Will be filled later if possible
          pinUrl: normalizePinUrl(href, pinId),
          source: 'pinterest',
          type: 'image'
        });
        newPinsCount++;
        return;
      }

      // Add to collected set and results array
      collectedPinIds.add(pinId);
      resultsArray.push({
        pinId,
        title: cleanText(img?.alt || ''),
        description: undefined,
        imageUrl: normalizeImageUrl(src),
        pinUrl: normalizePinUrl(href, pinId),
        source: 'pinterest',
        type: 'image'
      });
      newPinsCount++;
    } catch (err) {
      // Skip invalid elements
    }
  });

  return newPinsCount;
}

/**
 * Try to fill in missing image URLs for pins that were captured without images
 */
function fillMissingImages(
  collectedPinIds: Set<string>,
  resultsArray: ExtractedPin[]
): number {
  let filledCount = 0;
  const pinsNeedingImages = resultsArray.filter(p => !p.imageUrl);

  if (pinsNeedingImages.length === 0) return 0;

  const pinAnchors = document.querySelectorAll('a[href*="/pin/"]');

  pinAnchors.forEach(anchor => {
    const href = (anchor as HTMLAnchorElement).getAttribute('href') || '';
    const pinIdMatch = href.match(/\/pin\/(\d+)/);
    if (!pinIdMatch) return;

    const pinId = pinIdMatch[1];
    const pin = pinsNeedingImages.find(p => p.pinId === pinId);
    if (!pin || pin.imageUrl) return;

    // Try to find image
    let img: HTMLImageElement | null = anchor.querySelector('img');
    if (!img) {
      const parent = anchor.closest('[data-test-id="pin"]') ||
                     anchor.closest('[data-test-id="pinWrapper"]') ||
                     anchor.parentElement?.parentElement;
      if (parent) {
        img = parent.querySelector('img');
      }
    }
    if (!img && anchor.parentElement) {
      img = anchor.parentElement.querySelector('img');
    }

    if (img) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (isValidUrl(src)) {
        pin.imageUrl = normalizeImageUrl(src);
        pin.title = pin.title || cleanText(img.alt);
        filledCount++;
      }
    }
  });

  return filledCount;
}

// Legacy function for backward compatibility
function extractFromDom(seenIds: Set<string>): ExtractedPin[] {
  const pins: ExtractedPin[] = [];

  // Use seenIds directly as the collection tracker
  extractFromDomIncremental(seenIds, pins);

  return pins;
}

/**
 * Get the expected total pin count for the CURRENT BOARD only
 * This is used to verify if we've collected all pins
 *
 * IMPORTANT: Must distinguish between:
 * - Board pin count (what we want)
 * - User's total pins (what we DON'T want)
 * - Other counts on the page
 */
function getBoardPinCount(): number | null {
  console.log(`[Pinterest] Attempting to detect BOARD pin count...`);

  // Get current board info from URL to help validate
  const urlMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  const boardSlug = urlMatch ? urlMatch[2] : null;
  console.log(`[Pinterest] Current board slug: ${boardSlug}`);

  // Method 1: Check PWS data for board-specific pin_count
  const json = getPwsData();
  if (json) {
    // Look specifically for the board object that matches current URL
    const findBoardPinCount = (obj: any, depth = 0): number | null => {
      if (!obj || typeof obj !== 'object' || depth > 15) return null;

      // Check if this is a board object with pin_count
      // Board objects typically have: id, name, url, pin_count, type="board"
      if (obj.type === 'board' && obj.pin_count !== undefined && typeof obj.pin_count === 'number') {
        // Verify this is the current board by checking URL/slug
        const objUrl = obj.url || '';
        const objSlug = obj.slug || '';
        if (boardSlug && (objUrl.includes(boardSlug) || objSlug === boardSlug || !boardSlug)) {
          console.log(`[Pinterest] Found board pin_count in PWS (type=board): ${obj.pin_count}`);
          return obj.pin_count;
        }
      }

      // Check for board property with pin_count
      if (obj.board && typeof obj.board === 'object' && obj.board.pin_count !== undefined) {
        console.log(`[Pinterest] Found board.pin_count in PWS: ${obj.board.pin_count}`);
        return obj.board.pin_count;
      }

      // Check for boardFeed or similar resources
      if (obj.resource_type === 'board' && obj.data && obj.data.pin_count !== undefined) {
        console.log(`[Pinterest] Found board resource pin_count: ${obj.data.pin_count}`);
        return obj.data.pin_count;
      }

      // Recursively search, but skip user objects (which have total pin counts)
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findBoardPinCount(item, depth + 1);
          if (found !== null) return found;
        }
      } else {
        for (const [key, val] of Object.entries(obj)) {
          // Skip keys that are likely user data, not board data
          if (key === 'user' || key === 'owner' || key === 'pinner') continue;
          const found = findBoardPinCount(val, depth + 1);
          if (found !== null) return found;
        }
      }
      return null;
    };

    const pwsCount = findBoardPinCount(json);
    if (pwsCount !== null && pwsCount > 0) {
      return pwsCount;
    }
  }

  // Method 2: Look for pin count displayed near the board title (h1)
  // The board title is typically in an h1, and pin count is nearby
  const h1 = document.querySelector('h1');
  if (h1) {
    // Look in the same container as h1 for the pin count
    const container = h1.closest('div');
    if (container) {
      // Look for elements that ONLY contain pin count (not mixed with other text)
      const spans = container.querySelectorAll('span, div');
      for (let i = 0; i < spans.length; i++) {
        const el = spans[i];
        const text = (el.textContent || '').trim();
        // Match EXACT patterns like "1,008 Pins" - element should contain mostly just this
        if (text.length < 30) {
          const match = text.match(/^(\d[\d,.\s]*)\s*[Pp]ins?$/);
          if (match) {
            const countStr = match[1].replace(/[,.\s]/g, '');
            const count = parseInt(countStr, 10);
            if (!isNaN(count) && count > 0) {
              console.log(`[Pinterest] Found pin count near h1: ${count}`);
              return count;
            }
          }
        }
      }
    }

    // Also check siblings of h1
    let sibling = h1.nextElementSibling;
    while (sibling) {
      const text = (sibling.textContent || '').trim();
      if (text.length < 30) {
        const match = text.match(/^(\d[\d,.\s]*)\s*[Pp]ins?$/);
        if (match) {
          const countStr = match[1].replace(/[,.\s]/g, '');
          const count = parseInt(countStr, 10);
          if (!isNaN(count) && count > 0) {
            console.log(`[Pinterest] Found pin count in h1 sibling: ${count}`);
            return count;
          }
        }
      }
      sibling = sibling.nextElementSibling;
    }
  }

  // Method 3: Check meta description (often contains board-specific count)
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  // Meta description often starts with pin count for boards
  const metaMatch = metaDescription.match(/^(\d[\d,.\s]*)\s*[Pp]ins?/);
  if (metaMatch) {
    const countStr = metaMatch[1].replace(/[,.\s]/g, '');
    const count = parseInt(countStr, 10);
    if (!isNaN(count) && count > 0) {
      console.log(`[Pinterest] Found pin count in meta description: ${count}`);
      return count;
    }
  }

  // Method 4: Check page title
  const title = document.title || '';
  // Board pages often have title like "Board Name | Pinterest" or include pin count
  const titleMatch = title.match(/(\d[\d,.\s]*)\s*[Pp]ins?/);
  if (titleMatch) {
    const countStr = titleMatch[1].replace(/[,.\s]/g, '');
    const count = parseInt(countStr, 10);
    if (!isNaN(count) && count > 0) {
      console.log(`[Pinterest] Found pin count in title: ${count}`);
      return count;
    }
  }

  console.log(`[Pinterest] Could not determine board pin count - will extract without target`);
  return null;
}

// ============== BOARD EXTRACTION ==============
function extractBoardInfo(): BoardInfo | null {
  // Try to get board info from URL and page
  const urlMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (!urlMatch) return null;

  const username = urlMatch[1];
  const boardSlug = urlMatch[2];

  // Skip non-board pages
  const skipSlugs = ['_saved', '_created', 'pins', 'boards', 'followers', 'following'];
  if (skipSlugs.includes(boardSlug.toLowerCase())) return null;

  // Try to get board name from page
  const h1 = document.querySelector('h1');
  const boardName = h1?.textContent?.trim() || boardSlug.replace(/-/g, ' ');

  // Try to get board ID from PWS data
  const json = getPwsData();
  let boardId: string | undefined;

  if (json) {
    const findBoardId = (obj: any): string | undefined => {
      if (!obj || typeof obj !== 'object') return undefined;
      if (obj.board_id) return String(obj.board_id);
      if (obj.id && obj.type === 'board') return String(obj.id);
      for (const val of Object.values(obj)) {
        const found = findBoardId(val);
        if (found) return found;
      }
      return undefined;
    };
    boardId = findBoardId(json);
  }

  return {
    boardId: boardId || `slug:${boardSlug}`,
    name: boardName,
    url: location.href,
    pinCount: undefined
  };
}

function extractAllBoards(username: string): BoardInfo[] {
  const boards: BoardInfo[] = [];
  const seenUrls = new Set<string>();
  const skipSlugs = new Set(['_saved', '_created', '_pins', 'pins', 'followers', 'following', 'settings']);

  // Extract from PWS data
  const json = getPwsData();
  if (json) {
    const findBoards = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(findBoards);
        return;
      }

      // Check if this looks like a board
      if (obj.url && obj.name && (obj.type === 'board' || obj.pin_count !== undefined)) {
        const url = obj.url.startsWith('http') ? obj.url : `${location.origin}${obj.url}`;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          boards.push({
            boardId: String(obj.id || obj.board_id || `slug:${obj.slug}`),
            name: cleanText(obj.name),
            url,
            pinCount: obj.pin_count
          });
        }
      }

      Object.values(obj).forEach(findBoards);
    };
    findBoards(json);
  }

  // Also extract from DOM
  const boardLinks = document.querySelectorAll(`a[href*="/${username}/"]`);
  boardLinks.forEach(link => {
    const href = (link as HTMLAnchorElement).getAttribute('href') || '';
    const match = href.match(new RegExp(`^/?${username}/([^/]+)/?$`, 'i'));
    if (!match) return;

    const slug = match[1];
    if (skipSlugs.has(slug.toLowerCase())) return;

    const url = href.startsWith('http') ? href : `${location.origin}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    const name = link.getAttribute('aria-label') || link.textContent?.trim() || slug.replace(/-/g, ' ');
    boards.push({
      boardId: `slug:${slug}`,
      name: cleanText(name),
      url,
      pinCount: undefined
    });
  });

  return boards;
}

// ============== MAIN EXTRACTION WITH SCROLLING ==============

/**
 * Merge API-captured pins into the collection
 */
function mergeApiPins(
  collectedPinIds: Set<string>,
  allPins: ExtractedPin[]
): number {
  let newCount = 0;
  const apiPins = getApiCapturedPins();

  for (const pin of apiPins) {
    if (!collectedPinIds.has(pin.pinId)) {
      collectedPinIds.add(pin.pinId);
      allPins.push(pin);
      newCount++;
    }
  }

  return newCount;
}

/**
 * Advanced scroll extraction with up-down cycles to trigger deep loading
 * Uses: scroll to bottom → wait → scroll up → scroll down → wait → repeat
 * Stops when page height unchanged for several iterations
 */
async function performScrollExtraction(
  collectedPinIds: Set<string>,
  allPins: ExtractedPin[],
  seenIds: Set<string>,
  maxPins: number,
  expectedCount: number | null,
  onProgress: (progress: ExtractionProgress) => void
): Promise<{ scrollCount: number; newPinsFound: number }> {
  const startCount = collectedPinIds.size;
  let scrollCount = 0;
  let stableHeightCount = 0;
  let previousHeight = 0;

  // Ensure network interception is active
  setupNetworkInterception();

  // Scroll to top first
  window.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(2000);

  // Extract initial pins
  extractFromDomIncremental(collectedPinIds, allPins);
  mergeApiPins(collectedPinIds, allPins);

  previousHeight = document.body.scrollHeight;
  console.log(`[Pinterest] Initial: ${collectedPinIds.size} pins, page height: ${previousHeight}`);

  // Main scroll loop with advanced strategy
  while (scrollCount < MAX_SCROLLS && collectedPinIds.size < maxPins) {
    scrollCount++;
    const beforeExtract = collectedPinIds.size;

    // Update progress
    const pct = expectedCount ? ((collectedPinIds.size / expectedCount) * 100).toFixed(1) : '?';
    onProgress({
      status: 'scrolling',
      pinsCollected: collectedPinIds.size,
      scrollCount,
      message: expectedCount
        ? `${collectedPinIds.size}/${expectedCount} pins (${pct}%)`
        : `${collectedPinIds.size} pins collected`
    });

    // ============== ADVANCED SCROLL STRATEGY ==============
    // Step 1: Scroll to bottom of page
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth'
    });

    // Step 2: Wait 2.5 seconds for content to load
    await sleep(SCROLL_WAIT_MS);

    // Extract after first scroll
    extractFromDomIncremental(collectedPinIds, allPins);
    mergeApiPins(collectedPinIds, allPins);

    // Step 3: Scroll UP slightly (triggers lazy load)
    window.scrollBy({
      top: -SCROLL_UP_AMOUNT,
      behavior: 'smooth'
    });
    await sleep(800);

    // Step 4: Scroll back DOWN (triggers more loading)
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth'
    });

    // Step 5: Wait again for API responses
    await sleep(SCROLL_WAIT_MS);

    // Extract after up-down cycle
    extractFromDomIncremental(collectedPinIds, allPins);
    mergeApiPins(collectedPinIds, allPins);

    // Also check PWS data periodically
    if (scrollCount % 3 === 0) {
      const pwsPins = extractFromPwsData(seenIds);
      pwsPins.forEach(pin => {
        if (!collectedPinIds.has(pin.pinId)) {
          collectedPinIds.add(pin.pinId);
          allPins.push(pin);
        }
      });
    }

    const newThisScroll = collectedPinIds.size - beforeExtract;
    const currentHeight = document.body.scrollHeight;

    // Log progress
    console.log(`[Pinterest] Cycle ${scrollCount}: +${newThisScroll} pins (total: ${collectedPinIds.size}), height: ${currentHeight}`);

    // ============== DETECT TRUE END ==============
    // Check if page height has changed
    if (currentHeight === previousHeight) {
      stableHeightCount++;
      console.log(`[Pinterest] Page height unchanged (${stableHeightCount}/${STABLE_HEIGHT_ITERATIONS})`);

      // Try harder to trigger loading when height is stable
      if (stableHeightCount === 2) {
        console.log(`[Pinterest] Trying aggressive scroll to trigger more content...`);

        // Scroll way past bottom
        window.scrollTo({ top: currentHeight + 2000, behavior: 'instant' });
        await sleep(3000);

        // Scroll up significantly then back down
        window.scrollBy({ top: -window.innerHeight * 2, behavior: 'instant' });
        await sleep(1500);
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
        await sleep(3000);

        // Extract
        extractFromDomIncremental(collectedPinIds, allPins);
        mergeApiPins(collectedPinIds, allPins);

        // Check if we got more
        if (document.body.scrollHeight > currentHeight || collectedPinIds.size > beforeExtract) {
          console.log(`[Pinterest] Aggressive scroll worked!`);
          stableHeightCount = 0;
          previousHeight = document.body.scrollHeight;
          continue;
        }
      }

      // Stop if height unchanged for STABLE_HEIGHT_ITERATIONS
      if (stableHeightCount >= STABLE_HEIGHT_ITERATIONS) {
        console.log(`[Pinterest] Page height stable for ${stableHeightCount} cycles - reached end`);

        // One final attempt
        window.scrollTo({ top: 0, behavior: 'instant' });
        await sleep(2000);
        window.scrollTo({ top: document.body.scrollHeight + 5000, behavior: 'instant' });
        await sleep(4000);
        extractFromDomIncremental(collectedPinIds, allPins);
        mergeApiPins(collectedPinIds, allPins);

        if (document.body.scrollHeight === currentHeight) {
          console.log(`[Pinterest] Confirmed end of content`);
          break;
        } else {
          console.log(`[Pinterest] Found more content! Continuing...`);
          stableHeightCount = 0;
          previousHeight = document.body.scrollHeight;
        }
      }
    } else {
      // Page grew, reset counter
      stableHeightCount = 0;
      previousHeight = currentHeight;
    }
  }

  // Fill any missing images
  fillMissingImages(collectedPinIds, allPins);

  const totalNew = collectedPinIds.size - startCount;
  console.log(`[Pinterest] Scroll extraction complete: ${totalNew} new pins in ${scrollCount} cycles`);

  return {
    scrollCount,
    newPinsFound: totalNew
  };
}

/**
 * Main extraction function with network interception and retry logic
 *
 * IMPORTANT: This uses multiple extraction strategies:
 * 1. Network interception - captures pins from Pinterest API responses
 * 2. DOM extraction - captures pins from visible elements
 * 3. PWS data extraction - captures pins from initial page data
 * 4. All sources are merged and deduplicated
 */
async function extractPinsWithProgress(
  onProgress: (progress: ExtractionProgress) => void,
  maxPins: number = MAX_PINS
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const MAX_RETRY_ATTEMPTS = 3;
  const SYNC_THRESHOLD = 0.85;

  // Clear any previously captured API pins and ensure interception is active
  clearApiCapturedPins();
  setupNetworkInterception();

  // Get expected pin count from board (for progress display only)
  const expectedPinCount = getBoardPinCount();
  console.log(`[Pinterest] ====================================`);
  console.log(`[Pinterest] Starting extraction with API interception`);
  console.log(`[Pinterest] Expected pin count: ${expectedPinCount ?? 'unknown'}`);
  console.log(`[Pinterest] Max pins limit: ${maxPins}`);
  console.log(`[Pinterest] ====================================`);

  // CRITICAL: Global Set to track ALL collected pin IDs
  const collectedPinIds = new Set<string>();
  const allPins: ExtractedPin[] = [];
  const seenIds = new Set<string>();

  let totalScrollCount = 0;
  let retryAttempts = 0;
  let invalidCount = 0;

  isExtracting = true;

  try {
    onProgress({
      status: 'extracting',
      pinsCollected: 0,
      scrollCount: 0,
      message: expectedPinCount
        ? `Starting (expecting ~${expectedPinCount} pins)...`
        : 'Starting extraction...'
    });

    // Initial extraction from PWS data
    const pwsPins = extractFromPwsData(seenIds);
    pwsPins.forEach(pin => {
      if (!collectedPinIds.has(pin.pinId)) {
        collectedPinIds.add(pin.pinId);
        allPins.push(pin);
      }
    });
    console.log(`[Pinterest] Initial PWS extraction: ${allPins.length} pins`);

    // Initial DOM extraction
    extractFromDomIncremental(collectedPinIds, allPins);

    // Merge any already-captured API pins
    const initialApiMerge = mergeApiPins(collectedPinIds, allPins);
    console.log(`[Pinterest] Initial extraction: ${collectedPinIds.size} total (${initialApiMerge} from API)`);

    // Main extraction loop with retries
    let lastCount = 0;

    while (retryAttempts < MAX_RETRY_ATTEMPTS) {
      const attemptNum = retryAttempts + 1;
      console.log(`[Pinterest] ========== Pass ${attemptNum}/${MAX_RETRY_ATTEMPTS} ==========`);

      // Perform scroll extraction
      const { scrollCount, newPinsFound } = await performScrollExtraction(
        collectedPinIds,
        allPins,
        seenIds,
        maxPins,
        expectedPinCount,
        onProgress
      );
      totalScrollCount += scrollCount;

      console.log(`[Pinterest] Pass ${attemptNum} complete: +${newPinsFound} new, ${collectedPinIds.size} total`);

      // Check if we made progress
      if (collectedPinIds.size === lastCount || newPinsFound === 0) {
        console.log(`[Pinterest] No new pins found in this pass`);
        retryAttempts++;

        if (retryAttempts < MAX_RETRY_ATTEMPTS) {
          console.log(`[Pinterest] Will retry (${retryAttempts}/${MAX_RETRY_ATTEMPTS})...`);
          onProgress({
            status: 'extracting',
            pinsCollected: collectedPinIds.size,
            scrollCount: totalScrollCount,
            message: `Retrying... ${collectedPinIds.size} pins so far`
          });

          // Refresh by scrolling to top
          window.scrollTo({ top: 0, behavior: 'instant' });
          await sleep(3000);
        }
      } else {
        // Made progress, reset retry counter if we want to continue
        lastCount = collectedPinIds.size;

        // Check if we have enough
        if (expectedPinCount && collectedPinIds.size >= expectedPinCount * SYNC_THRESHOLD) {
          console.log(`[Pinterest] Reached ${((collectedPinIds.size / expectedPinCount) * 100).toFixed(1)}% of expected, stopping`);
          break;
        }
        if (collectedPinIds.size >= maxPins) {
          console.log(`[Pinterest] Reached max limit of ${maxPins}`);
          break;
        }

        // Continue without incrementing retry
        retryAttempts = 0;
      }
    }

    // Final pass: merge any remaining API-captured pins
    const finalApiMerge = mergeApiPins(collectedPinIds, allPins);
    if (finalApiMerge > 0) {
      console.log(`[Pinterest] Final API merge: +${finalApiMerge} pins`);
    }

    // Fill missing images
    const filledImages = fillMissingImages(collectedPinIds, allPins);
    if (filledImages > 0) {
      console.log(`[Pinterest] Filled ${filledImages} missing images`);
    }

    // Scroll back to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Deduplicate and validate pins
    const pinIdsSeen = new Set<string>();
    const validPins = allPins.filter(pin => {
      if (!pin.pinId) {
        invalidCount++;
        return false;
      }
      if (pinIdsSeen.has(pin.pinId)) {
        return false;
      }
      pinIdsSeen.add(pin.pinId);
      return true;
    });

    const pinsWithImages = validPins.filter(p => isValidUrl(p.imageUrl));
    const timeMs = Date.now() - startTime;

    // Determine sync status
    const isSyncComplete = expectedPinCount === null
      ? true
      : (validPins.length / expectedPinCount) >= SYNC_THRESHOLD;

    // Log final results with source breakdown
    const apiTotal = apiCapturedPins.size;
    console.log(`[Pinterest] ========== FINAL RESULT ==========`);
    console.log(`[Pinterest] Collected: ${validPins.length} pins (${pinsWithImages.length} with images)`);
    console.log(`[Pinterest] Sources: ${apiTotal} from API, rest from DOM/PWS`);
    console.log(`[Pinterest] Expected: ${expectedPinCount ?? 'unknown'}`);
    console.log(`[Pinterest] Sync complete: ${isSyncComplete}`);
    console.log(`[Pinterest] Time: ${Math.round(timeMs / 1000)}s, Scrolls: ${totalScrollCount}, Retries: ${retryAttempts}`);

    const syncMessage = expectedPinCount !== null
      ? `Synced ${validPins.length}/${expectedPinCount} pins (${((validPins.length / expectedPinCount) * 100).toFixed(0)}%)`
      : `Extracted ${validPins.length} pins`;

    onProgress({
      status: 'complete',
      pinsCollected: validPins.length,
      scrollCount: totalScrollCount,
      message: `${syncMessage} in ${Math.round(timeMs / 1000)}s`
    });

    return {
      success: true,
      pins: validPins,
      stats: {
        totalFound: validPins.length,
        expectedCount: expectedPinCount,
        syncComplete: isSyncComplete,
        fromApi: apiTotal,
        fromDom: validPins.length - apiTotal,
        duplicatesRemoved: allPins.length - validPins.length,
        invalidRemoved: invalidCount,
        scrollsPerformed: totalScrollCount,
        retryAttempts,
        timeMs
      }
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Pinterest] Extraction error:`, error);

    onProgress({
      status: 'error',
      pinsCollected: collectedPinIds.size,
      scrollCount: totalScrollCount,
      message: `Error: ${errorMsg}`
    });

    return {
      success: false,
      pins: allPins,
      error: errorMsg,
      stats: {
        totalFound: collectedPinIds.size,
        expectedCount: expectedPinCount,
        syncComplete: false,
        fromApi: apiCapturedPins.size,
        fromDom: collectedPinIds.size - apiCapturedPins.size,
        duplicatesRemoved: 0,
        invalidRemoved: invalidCount,
        scrollsPerformed: totalScrollCount,
        retryAttempts,
        timeMs: Date.now() - startTime
      }
    };
  } finally {
    isExtracting = false;
  }
}

// ============== QUICK EXTRACTION (NO SCROLLING) ==============
function extractPinsQuick(): ExtractedPin[] {
  const seenIds = new Set<string>();
  const pins: ExtractedPin[] = [];

  // Extract from PWS data first (most reliable)
  pins.push(...extractFromPwsData(seenIds));

  // Then from DOM
  pins.push(...extractFromDom(seenIds));

  return pins.filter(pin => pin.pinId && isValidUrl(pin.imageUrl));
}

// ============== PROGRESS BAR UI ==============
const progressUI = {
  container: null as HTMLDivElement | null,
  bar: null as HTMLDivElement | null,
  text: null as HTMLDivElement | null,

  show() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'openmemory-progress';
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2147483647;
      background: rgba(0,0,0,0.9);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    this.bar = document.createElement('div');
    this.bar.style.cssText = `
      flex: 1;
      height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 2px;
      overflow: hidden;
    `;

    const barInner = document.createElement('div');
    barInner.style.cssText = `
      height: 100%;
      width: 0%;
      background: #E60023;
      transition: width 0.3s ease;
    `;
    this.bar.appendChild(barInner);

    this.text = document.createElement('div');
    this.text.style.cssText = `
      color: white;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
    `;

    this.container.appendChild(this.bar);
    this.container.appendChild(this.text);
    document.body.appendChild(this.container);
  },

  update(percent: number, message: string) {
    if (!this.container) this.show();
    const barInner = this.bar?.firstChild as HTMLDivElement;
    if (barInner) barInner.style.width = `${Math.min(100, percent)}%`;
    if (this.text) this.text.textContent = message;
  },

  hide() {
    if (this.container) {
      this.container.remove();
      this.container = null;
      this.bar = null;
      this.text = null;
    }
  }
};

// ============== MESSAGE HANDLERS ==============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Import current board with progress
  if (message.type === 'PINTEREST_IMPORT_BOARD') {
    const maxPins = message.maxPins || MAX_PINS;

    (async () => {
      const boardInfo = extractBoardInfo();

      progressUI.show();
      progressUI.update(0, 'Starting import...');

      const result = await extractPinsWithProgress((progress) => {
        // Send progress to background
        chrome.runtime.sendMessage({
          type: 'PINTEREST_IMPORT_PROGRESS',
          progress
        });

        // Update UI
        const percent = Math.min(95, (progress.pinsCollected / maxPins) * 100);
        progressUI.update(percent, progress.message);
      }, maxPins);

      if (result.success && result.pins.length > 0) {
        progressUI.update(100, `Imported ${result.pins.length} pins!`);
      } else if (result.pins.length === 0) {
        progressUI.update(0, 'No pins found on this page');
      } else {
        progressUI.update(0, result.error || 'Import failed');
      }

      setTimeout(() => progressUI.hide(), 3000);

      sendResponse({
        ...result,
        boardInfo
      });
    })();

    return true; // Async response
  }

  // Quick extract (no scrolling)
  if (message.type === 'PINTEREST_QUICK_EXTRACT') {
    const pins = extractPinsQuick();
    const boardInfo = extractBoardInfo();
    sendResponse({ pins, boardInfo });
    return true;
  }

  // Get boards list
  if (message.type === 'PINTEREST_GET_BOARDS') {
    const username = message.username;
    const boards = extractAllBoards(username);
    sendResponse({ boards });
    return true;
  }

  // Fetch boards (with scrolling)
  if (message.type === 'PINTEREST_ACTIVE_FETCH_BOARDS') {
    const username = message.username as string;
    (async () => {
      // Quick scroll to load more boards
      for (let i = 0; i < 5; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(600);
      }
      window.scrollTo(0, 0);

      const boards = extractAllBoards(username);
      console.log(`[Pinterest] Found ${boards.length} boards`);
      sendResponse({ boards });
    })();
    return true;
  }

  // Fetch pins for a board
  if (message.type === 'PINTEREST_ACTIVE_FETCH_PINS') {
    const maxPins = message.maxPins || 200;
    (async () => {
      const result = await extractPinsWithProgress((progress) => {
        console.log(`[Pinterest Pins] ${progress.message}`);
      }, maxPins);

      sendResponse({
        pins: result.pins,
        error: result.error,
        stats: result.stats
      });
    })();
    return true;
  }

  // Set progress (from background)
  if (message.type === 'PINTEREST_ACTIVE_SET_PROGRESS') {
    const { percent, text, done } = message;
    if (done) {
      progressUI.update(100, text);
      setTimeout(() => progressUI.hide(), 3000);
    } else {
      progressUI.update(percent, text);
    }
    sendResponse({ ok: true });
    return true;
  }

  // Detect username
  if (message.type === 'PINTEREST_ACTIVE_DETECT_USERNAME') {
    const json = getPwsData();
    let username: string | undefined;

    // Find username in PWS data
    const findUsername = (obj: any): string | undefined => {
      if (!obj || typeof obj !== 'object') return undefined;
      if (obj.username && (obj.is_me || obj.is_self)) return obj.username;
      for (const val of Object.values(obj)) {
        const found = findUsername(val);
        if (found) return found;
      }
      return undefined;
    };

    username = findUsername(json);

    // Fallback: check URL
    if (!username) {
      const urlMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)/);
      if (urlMatch) username = urlMatch[1];
    }

    const loggedOut = !username && !!document.querySelector('a[href*="/login"]');
    sendResponse({ username, loggedOut });
    return true;
  }

  return false;
});

console.log('[OpenMemory] Pinterest content script loaded');
