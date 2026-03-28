/**
 * OpenMemory - Pinterest Integration
 * Cookie-based login detection and scraping logic
 */

import { db, PinterestPin, PinterestBoard } from './db';

// ============== INTERFACES ==============
export interface PinterestLoginStatus {
  loggedIn: boolean;
  username?: string;
}

export interface ScrapedBoard {
  name: string;
  url: string;
  boardId?: string;
  pinCount?: number;
}

export interface ScrapedPin {
  pinId: string;
  boardId?: string;
  title: string;
  imageUrl: string;
  imageBlob?: Blob;
  pinUrl: string;
  description?: string;
}

// ============== INTERNAL API FETCHING ==============
interface PinterestBoardsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    url?: string;
    pin_count?: number;
    is_secret?: boolean;
  }>;
  resource_response?: {
    data?: Array<{
      id?: string;
      name?: string;
      url?: string;
      pin_count?: number;
      is_secret?: boolean;
    }>;
    bookmark?: string;
  };
}

interface PinterestInitialState {
  props?: {
    initialReduxState?: {
      boards?: Record<string, any> | any[];
      pins?: Record<string, any> | any[];
    };
    initialState?: {
      resourceResponses?: Array<{
        response?: {
          data?: any;
        };
      }>;
    };
  };
}

interface PinterestBoardFeedResponse {
  resource_response?: {
    data?: Array<{
      id?: string;
      title?: string;
      description?: string;
      link?: string;
      images?: { orig?: { url?: string } };
    }>;
    bookmark?: string;
  };
}

export interface PinterestBoardFeedPin {
  pinId: string;
  title: string;
  description?: string;
  pinUrl: string;
  imageUrl: string;
}

function extractInitialStateJson(html: string): PinterestInitialState | null {
  const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const initialStateMatch = html.match(/<script id="initial-state" type="application\/json">([\s\S]*?)<\/script>/);
  const jsonText = pwsMatch?.[1] || initialStateMatch?.[1];
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText) as PinterestInitialState;
  } catch {
    return null;
  }
}

function normalizeBoardUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `https://www.pinterest.com${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractBoardsFromState(state: PinterestInitialState): Array<{ id?: string; name?: string; url?: string; pin_count?: number }> {
  const boards: Array<{ id?: string; name?: string; url?: string; pin_count?: number }> = [];

  const reduxBoards = state?.props?.initialReduxState?.boards;
  if (reduxBoards) {
    if (Array.isArray(reduxBoards)) {
      for (const board of reduxBoards) boards.push(board);
    } else if (typeof reduxBoards === 'object') {
      for (const key of Object.keys(reduxBoards)) {
        const board = reduxBoards[key];
        if (board) boards.push(board);
      }
    }
  }

  const resourceBoards = state?.props?.initialState?.resourceResponses?.[0]?.response?.data;
  if (resourceBoards) {
    if (Array.isArray(resourceBoards)) {
      for (const board of resourceBoards) boards.push(board);
    } else if (resourceBoards?.boards && Array.isArray(resourceBoards.boards)) {
      for (const board of resourceBoards.boards) boards.push(board);
    }
  }

  return boards;
}

function collectBoardsFromObject(value: unknown, found: Array<{ id?: string; name?: string; url?: string; pin_count?: number }>): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectBoardsFromObject(item, found);
    }
    return;
  }

  const obj = value as Record<string, any>;
  const boardId = obj.board_id || obj.id;
  const boardName = obj.name || obj.title;
  const boardUrl = obj.url;
  if (boardId && boardName && boardUrl) {
    found.push({
      id: String(boardId),
      name: String(boardName),
      url: String(boardUrl),
      pin_count: typeof obj.pin_count === 'number' ? obj.pin_count : undefined
    });
  }

  for (const key of Object.keys(obj)) {
    collectBoardsFromObject(obj[key], found);
  }
}

function extractPinsFromState(state: PinterestInitialState): Array<{ id?: string; title?: string; description?: string; link?: string; images?: { orig?: { url?: string } } }> {
  const pins: Array<{ id?: string; title?: string; description?: string; link?: string; images?: { orig?: { url?: string } } }> = [];

  const reduxPins = state?.props?.initialReduxState?.pins;
  if (reduxPins) {
    if (Array.isArray(reduxPins)) {
      for (const pin of reduxPins) pins.push(pin);
    } else if (typeof reduxPins === 'object') {
      for (const key of Object.keys(reduxPins)) {
        const pin = reduxPins[key];
        if (pin) pins.push(pin);
      }
    }
  }

  const resourcePins = state?.props?.initialState?.resourceResponses?.[0]?.response?.data;
  if (resourcePins) {
    if (Array.isArray(resourcePins)) {
      for (const pin of resourcePins) pins.push(pin);
    }
  }

  return pins;
}

export async function fetchPinterestBoards(username: string): Promise<PinterestBoard[]> {
  const boards: PinterestBoard[] = [];
  const seenIds = new Set<string>();

  // Use Pinterest's internal API with pagination
  let bookmark: string | undefined = undefined;
  let rounds = 0;
  const maxRounds = 20; // Safety limit

  console.log('[Pinterest API] Fetching boards for:', username);

  while (rounds < maxRounds) {
    const data = {
      options: {
        username,
        field_set_key: 'detailed',
        page_size: 250,
        bookmarks: bookmark ? [bookmark] : []
      },
      context: {}
    };

    const apiUrl = `https://www.pinterest.com/resource/BoardsResource/get/?source_url=/${username}/boards/&data=${encodeURIComponent(JSON.stringify(data))}`;

    try {
      const response = await fetch(apiUrl, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.log('[Pinterest API] Boards request failed:', response.status);
        break;
      }

      const json = await response.json();
      const dataList = json?.resource_response?.data || [];

      console.log(`[Pinterest API] Round ${rounds + 1}: got ${dataList.length} boards`);

      for (const item of dataList) {
        if (!item?.id || !item?.name || !item?.url) continue;
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);

        boards.push({
          boardId: String(item.id),
          name: String(item.name),
          url: normalizeBoardUrl(String(item.url)),
          pinCount: item.pin_count || 0,
          archived: false,
          updatedAt: Date.now()
        });
      }

      const nextBookmark = json?.resource_response?.bookmark;
      if (!nextBookmark || nextBookmark === '-end-') {
        console.log('[Pinterest API] No more boards (end of pagination)');
        break;
      }

      bookmark = nextBookmark;
      rounds++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (error) {
      console.error('[Pinterest API] Error fetching boards:', error);
      break;
    }
  }

  console.log('[Pinterest API] Total boards found:', boards.length);
  return boards;
}

export async function fetchPinterestBoardPins(boardId: string, boardUrl: string): Promise<PinterestBoardFeedPin[]> {
  const pins: PinterestBoardFeedPin[] = [];
  const seenIds = new Set<string>();

  // Extract path from URL for source_url
  let sourcePath = boardUrl;
  try {
    const urlObj = new URL(boardUrl);
    sourcePath = urlObj.pathname;
  } catch {
    // Use as-is if not a valid URL
  }
  if (!sourcePath.endsWith('/')) sourcePath += '/';

  // Use Pinterest's internal API with pagination
  let bookmark: string | undefined = undefined;
  let rounds = 0;
  const maxRounds = 50; // Allow more rounds for boards with many pins

  console.log('[Pinterest API] Fetching pins for board:', boardId);

  while (rounds < maxRounds) {
    const data = {
      options: {
        board_id: boardId,
        page_size: 250,
        bookmarks: bookmark ? [bookmark] : []
      },
      context: {}
    };

    const apiUrl = `https://www.pinterest.com/resource/BoardFeedResource/get/?source_url=${encodeURIComponent(sourcePath)}&data=${encodeURIComponent(JSON.stringify(data))}`;

    try {
      const response = await fetch(apiUrl, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        console.log('[Pinterest API] Pins request failed:', response.status);
        break;
      }

      const json = await response.json();
      const dataList = json?.resource_response?.data || [];

      if (rounds === 0 || dataList.length > 0) {
        console.log(`[Pinterest API] Round ${rounds + 1}: got ${dataList.length} pins`);
      }

      for (const item of dataList) {
        const pinId = item?.id;
        const imageUrl = item?.images?.orig?.url;
        if (!pinId || !imageUrl) continue;
        if (seenIds.has(pinId)) continue;
        seenIds.add(pinId);

        pins.push({
          pinId: String(pinId),
          title: item?.title || '',
          description: item?.description,
          pinUrl: `https://www.pinterest.com/pin/${pinId}/`,
          imageUrl: String(imageUrl)
        });
      }

      const nextBookmark = json?.resource_response?.bookmark;
      if (!nextBookmark || nextBookmark === '-end-') {
        break;
      }

      bookmark = nextBookmark;
      rounds++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 150));
    } catch (error) {
      console.error('[Pinterest API] Error fetching pins:', error);
      break;
    }
  }

  console.log('[Pinterest API] Total pins found for board:', pins.length);
  return pins;
}

// Pinterest domains to check
const PINTEREST_DOMAINS = [
  'https://www.pinterest.com',
  'https://in.pinterest.com',
  'https://pinterest.com',
  'https://br.pinterest.com',
  'https://de.pinterest.com',
  'https://fr.pinterest.com'
];

// ============== LOGIN DETECTION ==============
export async function checkPinterestLogin(): Promise<PinterestLoginStatus> {
  try {
    console.log('[Pinterest] Checking login status...');

    // Check for Pinterest session cookie across different domains
    for (const domain of PINTEREST_DOMAINS) {
      const sessionCookie = await chrome.cookies.get({
        url: domain,
        name: '_pinterest_sess'
      });

      if (sessionCookie) {
        console.log('[Pinterest] Session cookie found for:', domain);
        return { loggedIn: true };
      }

      const authCookie = await chrome.cookies.get({
        url: domain,
        name: '_auth'
      });

      if (authCookie) {
        console.log('[Pinterest] Auth cookie found for:', domain);
        return { loggedIn: true };
      }
    }

    console.log('[Pinterest] No cookies found');
    return { loggedIn: false };
  } catch (error) {
    console.error('[Pinterest] Login check error:', error);
    return { loggedIn: false };
  }
}

// Function to extract logged-in username from Pinterest page
// This focuses on finding the CURRENT USER, not random profiles
export function extractPinterestUsername(): string | null {
  console.log('[Pinterest Extract] Starting on:', window.location.href);

  // Method 1: Check for VIEWER (logged-in user) in __PWS_DATA__
  const pwsData = (window as any).__PWS_DATA__;
  if (pwsData) {
    // Viewer is the logged-in user
    if (pwsData?.props?.context?.viewer?.username) {
      console.log('[Pinterest Extract] Found viewer:', pwsData.props.context.viewer.username);
      return pwsData.props.context.viewer.username;
    }

    // Also check props.initialReduxState for viewer
    if (pwsData?.props?.initialReduxState?.viewer?.username) {
      return pwsData.props.initialReduxState.viewer.username;
    }

    // Search in stringified data for viewer specifically
    try {
      const dataStr = JSON.stringify(pwsData);
      const viewerMatch = dataStr.match(/"viewer"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
      if (viewerMatch) {
        console.log('[Pinterest Extract] Found viewer in JSON:', viewerMatch[1]);
        return viewerMatch[1];
      }
    } catch (e) {}
  }

  // Method 2: Check __INITIAL_STATE__ for viewer
  const initialState = (window as any).__INITIAL_STATE__;
  if (initialState) {
    if (initialState?.viewer?.username) {
      return initialState.viewer.username;
    }

    try {
      const stateStr = JSON.stringify(initialState);
      const viewerMatch = stateStr.match(/"viewer"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
      if (viewerMatch) {
        return viewerMatch[1];
      }
    } catch (e) {}
  }

  // Method 3: Check URL if on settings/profile page
  const urlMatch = window.location.href.match(/pinterest\.com\/([a-zA-Z0-9_]+)\/(settings|_saved|_created)/);
  if (urlMatch && !['www', 'in', 'br', 'de', 'fr', 'pin'].includes(urlMatch[1].toLowerCase())) {
    console.log('[Pinterest Extract] Found in URL:', urlMatch[1]);
    return urlMatch[1];
  }

  // Method 4: Find profile avatar/button in header (this is always the logged-in user)
  const avatarLinks = document.querySelectorAll('[data-test-id="header-profile"] a, [data-test-id="profile-button"], [aria-label*="profile" i] a');
  for (const link of avatarLinks) {
    const href = (link as HTMLAnchorElement).href;
    if (href) {
      const match = href.match(/pinterest\.com\/([a-zA-Z0-9_]+)\/?$/);
      if (match && !['pin', 'search', 'ideas', 'today', 'settings', 'business', 'login', 'www'].includes(match[1].toLowerCase())) {
        console.log('[Pinterest Extract] Found in avatar link:', match[1]);
        return match[1];
      }
    }
  }

  console.log('[Pinterest Extract] No viewer username found');
  return null;
}

// ============== SCRAPING FUNCTIONS ==============
// These functions are serialized and injected into Pinterest pages

export interface ScrapeBoardsResult {
  boards: ScrapedBoard[];
  debug: {
    url: string;
    username: string;
    totalLinks: number;
    userLinks: string[];
    bodyLength: number;
    foundInJson: boolean;
    jsonBoards: string[];
    apiBoardCount: number;
    apiBoards: string[];
  };
}

export async function scrapePinterestBoards(): Promise<ScrapeBoardsResult> {
  const boards: ScrapedBoard[] = [];
  const seenUrls = new Set<string>();
  const pathname = window.location.pathname;
  const username = pathname.split('/')[1];
  const baseUrl = window.location.origin;

  const jsonBoards: string[] = [];
  const apiBoards: string[] = [];
  const skipSlugs = ['_saved', '_created', '_pins', 'pin', 'settings', 'following', 'followers', 'ideas', 'search', 'about', 'home', 'messages', 'notifications', 'today', 'watch', 'shop'];

  // Helper to add board if not duplicate
  const addBoard = (name: string, url: string) => {
    // Normalize URL
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith('http')) {
      normalizedUrl = baseUrl + (normalizedUrl.startsWith('/') ? '' : '/') + normalizedUrl;
    }
    if (!normalizedUrl.endsWith('/')) {
      normalizedUrl += '/';
    }

    if (seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);

    // Clean up name
    const cleanName = (name || '').replace(/-/g, ' ').trim();
    if (cleanName.length > 0) {
      boards.push({ name: cleanName, url: normalizedUrl });
    }
  };

  // Helper to check if a slug is a valid board
  const isValidBoardSlug = (slug: string) => {
    if (!slug) return false;
    if (skipSlugs.includes(slug.toLowerCase())) return false;
    if (!/^[a-zA-Z0-9\-_]+$/.test(slug)) return false;
    return true;
  };

  console.log('[Pinterest Scraper] Starting board scrape on:', window.location.href);
  console.log('[Pinterest Scraper] Username from URL:', username);

  // Method 0: Call Pinterest internal boards API for full list
  if (username) {
    try {
      let bookmark: string | undefined = undefined;
      let rounds = 0;
      while (rounds < 10) {
        const data = {
          options: {
            username,
            page_size: 250,
            bookmarks: bookmark ? [bookmark] : []
          },
          context: {}
        };

        const apiUrl = `${baseUrl}/resource/BoardsResource/get/?source_url=/${username}/boards/&data=${encodeURIComponent(JSON.stringify(data))}`;
        const response = await fetch(apiUrl, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) break;

        const json = await response.json();
        const dataList = json?.resource_response?.data || [];
        for (const item of dataList) {
          if (!item?.url || !item?.name) continue;
          const slug = String(item.url).split('/').filter(Boolean).pop() || '';
          if (isValidBoardSlug(slug)) {
            apiBoards.push(item.name);
            addBoard(item.name, item.url);
          }
        }

        const nextBookmark = json?.resource_response?.bookmark;
        if (!nextBookmark || nextBookmark === '-end-') break;
        bookmark = nextBookmark;
        rounds++;
      }
    } catch (e) {
      console.log('[Pinterest Scraper] Boards API failed:', e);
    }
  }

  // Method 1: Try to find board data from Pinterest's __PWS_DATA__
  const pwsData = (window as any).__PWS_DATA__;
  if (pwsData) {
    try {
      const dataStr = JSON.stringify(pwsData);

      // Look for board objects with name and url
      const boardNameMatches = dataStr.matchAll(/"name"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"(\/[^"]+)"/g);
      for (const match of boardNameMatches) {
        const [, name, url] = match;
        if (url.toLowerCase().includes(`/${username?.toLowerCase()}/`)) {
          const slug = url.split('/').filter(Boolean).pop() || '';
          if (isValidBoardSlug(slug)) {
            jsonBoards.push(name);
            addBoard(name, url);
          }
        }
      }

      // Also try reverse order (url then name)
      const boardUrlMatches = dataStr.matchAll(/"url"\s*:\s*"(\/[^"]+)"[^}]*"name"\s*:\s*"([^"]+)"/g);
      for (const match of boardUrlMatches) {
        const [, url, name] = match;
        if (url.toLowerCase().includes(`/${username?.toLowerCase()}/`)) {
          const slug = url.split('/').filter(Boolean).pop() || '';
          if (isValidBoardSlug(slug)) {
            addBoard(name, url);
          }
        }
      }

      // Look for simple URL patterns
      const simpleMatches = dataStr.matchAll(/"url"\s*:\s*"\/?([^"\/]+)\/([a-zA-Z0-9\-_]+)\/?"/g);
      for (const match of simpleMatches) {
        const [, user, boardSlug] = match;
        if (user.toLowerCase() === username?.toLowerCase() && isValidBoardSlug(boardSlug)) {
          addBoard(boardSlug, `/${user}/${boardSlug}/`);
        }
      }
    } catch (e) {
      console.log('[Pinterest Scraper] Error parsing __PWS_DATA__:', e);
    }
  }

  // Method 2: Look for board data in __INITIAL_STATE__
  const initialState = (window as any).__INITIAL_STATE__;
  if (initialState) {
    try {
      const stateStr = JSON.stringify(initialState);
      const boardMatches = stateStr.matchAll(/"board"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"[^}]*"name"\s*:\s*"([^"]+)"/g);
      for (const match of boardMatches) {
        const [, url, name] = match;
        if (url.toLowerCase().includes(`/${username?.toLowerCase()}/`)) {
          const slug = url.split('/').filter(Boolean).pop() || '';
          if (isValidBoardSlug(slug)) {
            addBoard(name, url);
          }
        }
      }
    } catch (e) {
      console.log('[Pinterest Scraper] Error parsing __INITIAL_STATE__:', e);
    }
  }

  // Method 3: Look in all window objects for board data
  try {
    for (const key of Object.keys(window)) {
      if (key.startsWith('__') && key.includes('DATA') || key.includes('STATE') || key.includes('PROPS')) {
        const data = (window as any)[key];
        if (data && typeof data === 'object') {
          const dataStr = JSON.stringify(data);
          const matches = dataStr.matchAll(/"url"\s*:\s*"\/?([^"\/]+)\/([a-zA-Z0-9\-_]+)\/?"/g);
          for (const match of matches) {
            const [, user, boardSlug] = match;
            if (user.toLowerCase() === username?.toLowerCase() && isValidBoardSlug(boardSlug)) {
              addBoard(boardSlug, `/${user}/${boardSlug}/`);
            }
          }
        }
      }
    }
  } catch (e) {}

  // Method 4: Scan ALL anchor tags on the page (always do this)
  const allAnchors = document.querySelectorAll('a[href]');
  console.log('[Pinterest Scraper] Found', allAnchors.length, 'anchor tags');

  allAnchors.forEach(anchor => {
    const href = (anchor as HTMLAnchorElement).href || anchor.getAttribute('href') || '';
    if (!href) return;

    // Match board URL pattern
    const boardMatch = href.match(/pinterest\.com\/([^\/]+)\/([^\/\?#]+)\/?/);
    if (boardMatch) {
      const [, linkUser, boardSlug] = boardMatch;
      if (linkUser.toLowerCase() === username?.toLowerCase() && isValidBoardSlug(boardSlug)) {
        // Try to get a better name from the element
        let name = boardSlug;
        const textContent = anchor.textContent?.trim();
        if (textContent && textContent.length > 0 && textContent.length < 100 && !textContent.includes('\n')) {
          name = textContent;
        }
        // Also check for aria-label
        const ariaLabel = anchor.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 100) {
          name = ariaLabel;
        }
        addBoard(name, href);
      }
    }
  });

  // Method 5: Look for board cards/containers with data attributes
  const boardContainers = document.querySelectorAll('[data-test-id*="board"], [data-test-id*="Board"], [class*="board"], [class*="Board"]');
  boardContainers.forEach(container => {
    const link = container.querySelector('a[href]') as HTMLAnchorElement;
    if (link?.href) {
      const boardMatch = link.href.match(/pinterest\.com\/([^\/]+)\/([^\/\?#]+)\/?/);
      if (boardMatch) {
        const [, linkUser, boardSlug] = boardMatch;
        if (linkUser.toLowerCase() === username?.toLowerCase() && isValidBoardSlug(boardSlug)) {
          // Try to find name in container
          let name = boardSlug;
          const nameEl = container.querySelector('h2, h3, [class*="name"], [class*="title"]');
          if (nameEl?.textContent) {
            name = nameEl.textContent.trim();
          }
          addBoard(name, link.href);
        }
      }
    }
  });

  // Method 6: Parse script tags for board data
  const scripts = document.querySelectorAll('script:not([src])');
  scripts.forEach(script => {
    const content = script.textContent || '';
    if (content.length < 500 || content.length > 5000000) return;

    try {
      const urlMatches = content.matchAll(/"url"\s*:\s*"\/?([^"\/]+)\/([a-zA-Z0-9\-_]+)\/?"/g);
      for (const match of urlMatches) {
        const [, user, boardSlug] = match;
        if (user.toLowerCase() === username?.toLowerCase() && isValidBoardSlug(boardSlug)) {
          addBoard(boardSlug, `/${user}/${boardSlug}/`);
        }
      }
    } catch (e) {}
  });

  console.log('[Pinterest Scraper] Total boards found:', boards.length);

  // Collect debug info
  const allLinks = document.querySelectorAll('a');
  const userLinks: string[] = [];
  allLinks.forEach(link => {
    const href = (link as HTMLAnchorElement).href;
    if (href && href.toLowerCase().includes(username?.toLowerCase() || '') && !href.includes('#')) {
      userLinks.push(href);
    }
  });

  console.log('[Pinterest] Board scrape complete. Found:', boards.length);

  return {
    boards,
    debug: {
      url: window.location.href,
      username: username || '',
      totalLinks: allLinks.length,
      userLinks: userLinks.slice(0, 20),
      bodyLength: document.body.innerHTML.length,
      foundInJson: jsonBoards.length > 0,
      jsonBoards: jsonBoards.slice(0, 10),
      apiBoardCount: apiBoards.length,
      apiBoards: apiBoards.slice(0, 10)
    }
  };
}

export function scrapeBoardPins(): ScrapedPin[] {
  const pins: ScrapedPin[] = [];

  console.log('[Pinterest Scraper] Looking for pins on:', window.location.href);
  console.log('[Pinterest Scraper] Page title:', document.title);
  console.log('[Pinterest Scraper] Body length:', document.body.innerHTML.length);

  // Find all pin links on the page
  const pinLinks = document.querySelectorAll('a[href*="/pin/"]');
  console.log('[Pinterest Scraper] Found', pinLinks.length, 'pin links');

  // Also try finding images directly
  const allImages = document.querySelectorAll('img[src*="pinimg.com"]');
  console.log('[Pinterest Scraper] Found', allImages.length, 'Pinterest images');

  pinLinks.forEach(link => {
    const pinUrl = (link as HTMLAnchorElement).href;
    const pinIdMatch = pinUrl.match(/\/pin\/(\d+)/);
    const pinId = pinIdMatch?.[1] || '';

    if (!pinId || pins.some(p => p.pinId === pinId)) return;

    // Find image in or near this link
    let img = link.querySelector('img') as HTMLImageElement;
    if (!img) {
      const parent = link.closest('div');
      img = parent?.querySelector('img') as HTMLImageElement;
    }

    const imageUrl = img?.src || img?.dataset?.src || '';

    pins.push({
      pinId,
      title: img?.alt || '',
      imageUrl,
      pinUrl,
      description: ''
    });
  });

  // If no pins found via links, try to extract from images
  if (pins.length === 0 && allImages.length > 0) {
    console.log('[Pinterest Scraper] Trying to extract pins from images...');
    allImages.forEach((img, index) => {
      const imgEl = img as HTMLImageElement;
      const src = imgEl.src || '';
      // Try to find a nearby pin link
      const container = imgEl.closest('div[data-test-id]') || imgEl.closest('div');
      const pinLink = container?.querySelector('a[href*="/pin/"]') as HTMLAnchorElement;

      if (pinLink) {
        const pinIdMatch = pinLink.href.match(/\/pin\/(\d+)/);
        const pinId = pinIdMatch?.[1] || `img_${index}`;

        if (!pins.some(p => p.pinId === pinId)) {
          pins.push({
            pinId,
            title: imgEl.alt || '',
            imageUrl: src,
            pinUrl: pinLink.href,
            description: ''
          });
        }
      }
    });
  }

  console.log('[Pinterest Scraper] Total pins found:', pins.length);
  if (pins.length > 0) {
    console.log('[Pinterest Scraper] First pin:', pins[0]);
  }

  return pins.slice(0, 50);
}

// Function to scroll and wait for content to load
export function scrollToLoadContent(): Promise<void> {
  return new Promise((resolve) => {
    let scrollCount = 0;
    const maxScrolls = 8;

    const scrollInterval = setInterval(() => {
      window.scrollBy(0, window.innerHeight * 0.8);
      scrollCount++;
      console.log('[Pinterest Scraper] Scroll', scrollCount, 'of', maxScrolls);

      if (scrollCount >= maxScrolls) {
        clearInterval(scrollInterval);
        window.scrollTo(0, 0);
        setTimeout(resolve, 2000);
      }
    }, 800);
  });
}

// ============== PIN PROCESSING ==============
export async function processPin(
  pin: ScrapedPin,
  boardName: string,
  boardUrl: string
): Promise<void> {
  // Check if pin already exists
  const existing = await db.pins.where('pinId').equals(pin.pinId).first();
  if (existing) {
    return;
  }

  // Store in database (skip image conversion for now - use original URL)
  const pinData: PinterestPin = {
    pinId: pin.pinId,
    boardId: pin.boardId,
    boardName,
    boardUrl,
    title: pin.title,
    description: pin.description,
    pinUrl: pin.pinUrl,
    originalImageUrl: pin.imageUrl,
    imageBlob: pin.imageBlob,
    syncedAt: Date.now()
  };

  await db.pins.add(pinData);
}

// ============== IMAGE CONVERSION ==============
let offscreenDocumentCreated = false;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenDocumentCreated) return;

  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: 'Convert Pinterest images to WebP format for storage'
    });

    offscreenDocumentCreated = true;
  } catch (error) {
    console.warn('[Pinterest] Failed to create offscreen document:', error);
  }
}

export async function convertImageToWebP(imageUrl: string): Promise<Blob | undefined> {
  await ensureOffscreenDocument();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CONVERT_IMAGE_TO_WEBP',
      imageUrl
    });

    if (response && response.blob) {
      // Convert array buffer back to blob
      return new Blob([response.blob], { type: 'image/webp' });
    }
  } catch (error) {
    console.warn('[Pinterest] Image conversion failed:', error);
  }

  return undefined;
}

// ============== INTEGRATION MANAGEMENT ==============
export async function initializePinterestIntegration(): Promise<void> {
  const existing = await db.integrations.where('name').equals('pinterest').first();

  if (!existing) {
    await db.integrations.add({
      name: 'pinterest',
      connected: false,
      syncStatus: 'idle'
    });
  }
}

export async function updatePinterestIntegration(updates: Partial<{
  username: string;
  connected: boolean;
  lastSyncAt: number;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncProgress: number;
  totalPins: number;
  boardTotal: number;
  boardUpdated: number;
  boardArchived: number;
}>): Promise<void> {
  await db.integrations.where('name').equals('pinterest').modify(updates);
}

export async function getPinterestIntegration() {
  return db.integrations.where('name').equals('pinterest').first();
}
