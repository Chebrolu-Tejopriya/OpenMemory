type ActiveBoard = {
  boardId?: string;
  name: string;
  url: string;
  pinCount?: number;
};

type ActivePin = {
  pinId: string;
  title: string;
  description?: string;
  imageUrl: string;
  pinUrl: string;
};

const progressState = {
  container: null as HTMLDivElement | null,
  bar: null as HTMLDivElement | null,
  text: null as HTMLDivElement | null
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureProgressBar(): void {
  if (progressState.container) return;

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.right = '0';
  container.style.height = '3px';
  container.style.zIndex = '2147483647';
  container.style.background = 'rgba(0,0,0,0.1)';

  const bar = document.createElement('div');
  bar.style.height = '100%';
  bar.style.width = '0%';
  bar.style.background = '#000000';
  bar.style.transition = 'width 0.3s ease';

  const text = document.createElement('div');
  text.style.position = 'fixed';
  text.style.top = '8px';
  text.style.left = '12px';
  text.style.zIndex = '2147483647';
  text.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  text.style.fontSize = '12px';
  text.style.fontWeight = '600';
  text.style.color = '#111111';
  text.style.background = 'rgba(255,255,255,0.92)';
  text.style.padding = '6px 10px';
  text.style.borderRadius = '999px';
  text.style.boxShadow = '0 6px 18px rgba(0,0,0,0.15)';

  container.appendChild(bar);
  document.documentElement.appendChild(container);
  document.documentElement.appendChild(text);

  progressState.container = container;
  progressState.bar = bar;
  progressState.text = text;
}

function setProgress(percent: number, message: string, done = false): void {
  ensureProgressBar();
  if (!progressState.bar || !progressState.text) return;

  const clamped = Math.max(0, Math.min(100, percent));
  progressState.bar.style.width = `${clamped}%`;
  progressState.bar.style.background = done ? '#16a34a' : '#000000';
  progressState.text.style.color = done ? '#16a34a' : '#111111';
  progressState.text.textContent = message;
}

function getPwsData(): any | null {
  const el = document.getElementById('__PWS_DATA__');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

function getCsrfToken(): string | undefined {
  const cookieMatch = document.cookie.match(/csrftoken=([^;]+)/);
  if (cookieMatch?.[1]) return cookieMatch[1];

  const altCookieMatch = document.cookie.match(/csrf_token=([^;]+)/);
  if (altCookieMatch?.[1]) return altCookieMatch[1];

  const meta = document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null;
  if (meta?.content) return meta.content;

  const pws = getPwsData();
  const token = pws?.props?.csrfToken || pws?.props?.csrf_token;
  if (token) return String(token);

  return undefined;
}

async function fetchBoardsApiForSource(username: string, sourceUrl: string): Promise<{ boards: ActiveBoard[]; error?: string }> {
  const boards: ActiveBoard[] = [];
  let bookmark: string | undefined = undefined;
  let rounds = 0;
  const csrf = getCsrfToken();

  console.log('[Pinterest API] fetchBoardsApiForSource:', { username, sourceUrl, csrf: csrf ? 'present' : 'missing' });

  // Try different field_set_key values that Pinterest might use
  const fieldSetKeys = ['profile_grid_item', 'grid_item', 'detailed', 'redux'];

  for (const fieldSetKey of fieldSetKeys) {
    if (boards.length > 0) break; // Found boards, stop trying other field keys

    bookmark = undefined;
    rounds = 0;

    console.log('[Pinterest API] Trying field_set_key:', fieldSetKey);

    while (rounds < 40) {
      const data = {
        options: {
          username,
          field_set_key: fieldSetKey,
          page_size: 250,
          filter: 'all',
          sort: 'last_pinned_to',
          ...(bookmark ? { bookmarks: [bookmark] } : {})
        },
        context: {}
      };

      const url = `${location.origin}/resource/BoardsResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;

      if (rounds === 0) {
        console.log('[Pinterest API] Request URL:', url.substring(0, 200) + '...');
      }

      const response = await fetch(url, {
        credentials: 'include',
        referrer: location.href,
        headers: {
          'Accept': 'application/json, text/javascript, */*, q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Pinterest-AppState': 'active',
          'X-Pinterest-Source-Url': sourceUrl,
          'X-APP-VERSION': 'e2d8c',
          ...(csrf ? { 'X-CSRFToken': csrf } : {})
        }
      });

      console.log('[Pinterest API] Response status:', response.status, 'field_set_key:', fieldSetKey);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.log('[Pinterest API] Error response:', errorText.substring(0, 200));
        break; // Try next field_set_key
      }

      const json = await response.json();
      const dataList = json?.resource_response?.data || json?.data || [];

      console.log('[Pinterest API] Got', dataList.length, 'items with field_set_key:', fieldSetKey);

      if (dataList.length === 0 && rounds === 0) {
        console.log('[Pinterest API] Empty response, trying to find boards in response...');
        console.log('[Pinterest API] JSON keys:', Object.keys(json || {}));
        if (json?.resource_response) {
          console.log('[Pinterest API] resource_response:', JSON.stringify(json.resource_response).substring(0, 500));
        }
        break; // Try next field_set_key
      }

      for (const item of dataList) {
        // Handle different response formats
        const boardId = item?.id || item?.board_id;
        const boardName = item?.name || item?.title;
        const boardUrl = item?.url;

        if (!boardId || !boardName) continue;

        const absoluteUrl = boardUrl
          ? (boardUrl.startsWith('http') ? boardUrl : `${location.origin}${boardUrl.startsWith('/') ? '' : '/'}${boardUrl}`)
          : `${location.origin}/${username}/${item.slug || boardId}/`;

        boards.push({
          boardId: String(boardId),
          name: String(boardName),
          url: absoluteUrl,
          pinCount: typeof item.pin_count === 'number' ? item.pin_count : undefined
        });
      }

      const nextBookmark = json?.resource_response?.bookmark;
      if (!nextBookmark || nextBookmark === '-end-') break;
      bookmark = nextBookmark;
      rounds += 1;
      await sleep(200);
    }
  }

  if (boards.length === 0) {
    return { boards: [], error: 'BoardsResource returned no boards with any field_set_key' };
  }

  return { boards };
}

async function fetchUserBoardsResource(username: string): Promise<{ boards: ActiveBoard[]; error?: string }> {
  const boards: ActiveBoard[] = [];
  let bookmark: string | undefined = undefined;
  let rounds = 0;
  const csrf = getCsrfToken();

  console.log('[Pinterest API] Trying UserBoardsResource for:', username);

  while (rounds < 40) {
    const data = {
      options: {
        username,
        page_size: 250,
        privacy_filter: 'all',
        sort: 'alphabetical',
        field_set_key: 'profile_grid_item',
        ...(bookmark ? { bookmarks: [bookmark] } : {})
      },
      context: {}
    };

    const sourceUrl = `/${username}/_saved/`;
    const url = `${location.origin}/resource/UserBoardsResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;

    if (rounds === 0) {
      console.log('[Pinterest API] UserBoardsResource URL:', url.substring(0, 200));
    }

    try {
      const response = await fetch(url, {
        credentials: 'include',
        referrer: location.href,
        headers: {
          'Accept': 'application/json, text/javascript, */*, q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Pinterest-AppState': 'active',
          'X-Pinterest-Source-Url': sourceUrl,
          ...(csrf ? { 'X-CSRFToken': csrf } : {})
        }
      });

      console.log('[Pinterest API] UserBoardsResource status:', response.status);

      if (!response.ok) {
        return { boards: [], error: `UserBoardsResource HTTP ${response.status}` };
      }

      const json = await response.json();
      const dataList = json?.resource_response?.data || [];

      console.log('[Pinterest API] UserBoardsResource got', dataList.length, 'items');

      for (const item of dataList) {
        const boardId = item?.id || item?.board_id;
        const boardName = item?.name;
        if (!boardId || !boardName) continue;

        const boardUrl = item?.url || `/${username}/${item.slug || boardId}/`;
        const absoluteUrl = boardUrl.startsWith('http')
          ? boardUrl
          : `${location.origin}${boardUrl.startsWith('/') ? '' : '/'}${boardUrl}`;

        boards.push({
          boardId: String(boardId),
          name: String(boardName),
          url: absoluteUrl,
          pinCount: typeof item.pin_count === 'number' ? item.pin_count : undefined
        });
      }

      const nextBookmark = json?.resource_response?.bookmark;
      if (!nextBookmark || nextBookmark === '-end-') break;
      bookmark = nextBookmark;
      rounds += 1;
      await sleep(200);
    } catch (e) {
      console.log('[Pinterest API] UserBoardsResource error:', e);
      return { boards: [], error: 'UserBoardsResource request failed' };
    }
  }

  return { boards };
}

async function fetchBoardsApi(username: string): Promise<{ boards: ActiveBoard[]; error?: string }> {
  console.log('[Pinterest API] Fetching boards for:', username, 'from origin:', location.origin);

  // Try UserBoardsResource first (often more reliable)
  const userBoardsResult = await fetchUserBoardsResource(username);
  if (userBoardsResult.boards.length > 0) {
    console.log('[Pinterest API] UserBoardsResource returned', userBoardsResult.boards.length, 'boards');
    return userBoardsResult;
  }

  // Fallback to BoardsResource with different source URLs
  const sources = [
    `/${username}/_saved/`,
    `/${username}/boards/`,
    `/${username}/`
  ];

  let lastError: string | undefined = userBoardsResult.error;
  for (const sourceUrl of sources) {
    console.log('[Pinterest API] Trying BoardsResource with source:', sourceUrl);
    const result = await fetchBoardsApiForSource(username, sourceUrl);
    console.log('[Pinterest API] Result:', result.boards.length, 'boards, error:', result.error);
    if (result.boards.length > 0) return result;
    if (result.error) lastError = result.error;
  }

  return { boards: [], error: lastError };
}

function normalizeBoardHost(url: string): string {
  if (!url) return url;
  const hostMatch = location.origin.match(/https:\/\/(?:[a-z]{2}\.)?pinterest\.com/i);
  const base = hostMatch ? hostMatch[0] : location.origin;
  if (!url.startsWith('http')) {
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('pinterest.com')) {
      return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return url;
  }
  return url;
}

async function fetchPinsApi(boardId: string, boardUrl: string): Promise<{ pins: ActivePin[]; error?: string }> {
  const pins: ActivePin[] = [];
  let bookmark: string | undefined = undefined;
  let rounds = 0;
  const csrf = getCsrfToken();

  while (rounds < 60) {
    const data = {
      options: {
        board_id: boardId,
        page_size: 250,
        bookmarks: bookmark ? [bookmark] : []
      },
      context: {}
    };

    const path = new URL(boardUrl).pathname;
    const sourceUrl = path.endsWith('/') ? path : `${path}/`;
    const url = `${location.origin}/resource/BoardFeedResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;
    const response = await fetch(url, {
      credentials: 'include',
      referrer: location.href,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-Pinterest-AppState': 'active',
        'X-Pinterest-Source-Url': sourceUrl,
        ...(csrf ? { 'X-CSRFToken': csrf } : {})
      }
    });

    if (!response.ok) {
      return { pins, error: `BoardFeedResource HTTP ${response.status}` };
    }
    const json = await response.json();
    const dataList = json?.resource_response?.data || [];

    for (const item of dataList) {
      const pinId = item?.id;
      const imageUrl = item?.images?.orig?.url;
      if (!pinId || !imageUrl) continue;
      pins.push({
        pinId: String(pinId),
        title: item?.title || '',
        description: item?.description,
        imageUrl: String(imageUrl),
        pinUrl: `https://www.pinterest.com/pin/${pinId}/`
      });
    }

    const nextBookmark = json?.resource_response?.bookmark;
    if (!nextBookmark || nextBookmark === '-end-') break;
    bookmark = nextBookmark;
    rounds += 1;
    await sleep(200);
  }

  return { pins };
}

function collectFromObject(value: any, onItem: (item: any) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFromObject(item, onItem));
    return;
  }

  onItem(value);
  Object.keys(value).forEach((key) => collectFromObject(value[key], onItem));
}

function extractUsername(): { username?: string; loggedOut: boolean } {
  const loginButton = document.querySelector('a[href*="/login"], button[data-test-id*="login"], button[aria-label*="Log in"], a[aria-label*="Log in"]');
  const reserved = new Set(['pin', 'search', 'ideas', 'today', 'settings', 'business', 'login', 'www', 'home', 'watch', 'shop', 'messages', 'notifications']);

  const json = getPwsData();
  let username: string | undefined;

  if (json) {
    collectFromObject(json, (item) => {
      if (!username && item?.username && (item?.is_me || item?.is_self)) {
        username = String(item.username);
      }
    });
  }

  if (!username) {
    const profileLink = document.querySelector('a[href^="/"][data-test-id*="header-profile"], a[aria-label*="Profile"]') as HTMLAnchorElement | null;
    const href = profileLink?.getAttribute('href') || '';
    const match = href.match(/^\/?([A-Za-z0-9_]+)\/?$/);
    if (match && !reserved.has(match[1].toLowerCase())) {
      username = match[1];
    }
  }

  if (!username) {
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/^\/?([A-Za-z0-9_]+)\/?$/);
      if (match && !reserved.has(match[1].toLowerCase())) {
        username = match[1];
        break;
      }
    }
  }

  return { username, loggedOut: !username && !!loginButton };
}

function extractBoards(username: string): ActiveBoard[] {
  const boards: ActiveBoard[] = [];
  const seen = new Set<string>();
  const skipSlugs = new Set(['_saved', '_created', '_boards', '_pins', 'pin', 'search', 'ideas', 'today', 'settings', 'business', 'login', 'watch', 'shop', 'notifications', 'messages', 'home']);
  const skipPatterns = [/^_/, /profile/i];

  console.log('[Pinterest DOM] Extracting boards for user:', username);

  const json = getPwsData();

  // Try to extract from __PWS_DATA__ first (most reliable)
  if (json) {
    console.log('[Pinterest DOM] Found __PWS_DATA__, searching for boards...');

    // Search in resourceResponses
    const resourceResponses = json?.props?.initialReduxState?.resourceResponses;
    if (resourceResponses) {
      collectFromObject(resourceResponses, (item) => {
        // Check if this looks like a board
        if (item?.type !== 'board' && !item?.board_id && !(item?.id && item?.name && item?.url && item?.pin_count !== undefined)) {
          return;
        }

        const boardId = item?.board_id || item?.id;
        const boardName = item?.name || item?.title;
        const boardUrl = item?.url;
        if (!boardId || !boardName || !boardUrl) return;

        // Skip if it looks like a profile URL
        if (skipPatterns.some(p => p.test(boardUrl))) return;

        const absoluteUrl = normalizeBoardHost(boardUrl);
        if (seen.has(absoluteUrl)) return;
        seen.add(absoluteUrl);
        boards.push({
          boardId: String(boardId),
          name: String(boardName),
          url: absoluteUrl,
          pinCount: typeof item?.pin_count === 'number' ? item.pin_count : undefined
        });
      });
    }

    // Search in boards object
    const reduxBoards = json?.props?.initialReduxState?.boards;
    if (reduxBoards && typeof reduxBoards === 'object') {
      for (const key of Object.keys(reduxBoards)) {
        const item = reduxBoards[key];
        if (!item || typeof item !== 'object') continue;

        const boardId = item?.id || key;
        const boardName = item?.name || item?.title;
        const boardUrl = item?.url;

        if (!boardId || !boardName) continue;

        const absoluteUrl = boardUrl
          ? normalizeBoardHost(boardUrl)
          : `${location.origin}/${username}/${item.slug || boardId}/`;

        if (seen.has(absoluteUrl)) continue;
        if (skipPatterns.some(p => p.test(absoluteUrl))) continue;

        seen.add(absoluteUrl);
        boards.push({
          boardId: String(boardId),
          name: String(boardName),
          url: absoluteUrl,
          pinCount: typeof item?.pin_count === 'number' ? item.pin_count : undefined
        });
      }
    }

    console.log('[Pinterest DOM] Found', boards.length, 'boards from __PWS_DATA__');
  }

  // DOM fallback - look for board links
  if (boards.length === 0) {
    console.log('[Pinterest DOM] No boards from __PWS_DATA__, trying DOM extraction...');

    // Look for board containers first (more specific)
    const boardContainers = document.querySelectorAll('[data-test-id*="board"], [data-grid-item], div[role="listitem"]');
    console.log('[Pinterest DOM] Found', boardContainers.length, 'potential board containers');

    boardContainers.forEach((container) => {
      const anchor = container.querySelector('a[href*="/' + username + '/"]') as HTMLAnchorElement;
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';
      const parts = href.split('/').filter(Boolean);

      // Board URLs are typically /username/board-name/
      if (parts.length < 2) return;
      if (parts[0].toLowerCase() !== username.toLowerCase()) return;

      const slug = parts[1];
      if (!slug || skipSlugs.has(slug.toLowerCase())) return;
      if (skipPatterns.some(p => p.test(slug))) return;

      const absoluteUrl = normalizeBoardHost(href);
      if (seen.has(absoluteUrl)) return;
      seen.add(absoluteUrl);

      // Try to get the board name from various sources
      const nameEl = container.querySelector('h3, [data-test-id*="board-name"], div[style*="font-weight"]');
      const name = nameEl?.textContent?.trim() || anchor.getAttribute('aria-label') || slug.replace(/-/g, ' ');

      if (name && name !== username) {
        boards.push({ boardId: `slug:${slug}`, name, url: absoluteUrl });
      }
    });

    // If still no boards, try a broader search
    if (boards.length === 0) {
      console.log('[Pinterest DOM] Trying broader link search...');

      const allAnchors = document.querySelectorAll<HTMLAnchorElement>(`a[href*="/${username}/"]`);
      allAnchors.forEach((anchor) => {
        const href = anchor.getAttribute('href') || '';
        const parts = href.split('/').filter(Boolean);

        if (parts.length < 2) return;
        if (parts[0].toLowerCase() !== username.toLowerCase()) return;

        const slug = parts[1];
        if (!slug || skipSlugs.has(slug.toLowerCase())) return;
        if (skipPatterns.some(p => p.test(slug))) return;

        // Skip if this looks like a pin URL
        if (parts.length > 2 && parts[2] === 'pin') return;

        const absoluteUrl = normalizeBoardHost(href);
        if (seen.has(absoluteUrl)) return;
        seen.add(absoluteUrl);

        const name = anchor.getAttribute('aria-label') || anchor.textContent?.trim() || slug.replace(/-/g, ' ');

        if (name && name !== username && name.toLowerCase() !== 'your profile') {
          boards.push({ boardId: `slug:${slug}`, name, url: absoluteUrl });
        }
      });
    }

    console.log('[Pinterest DOM] Found', boards.length, 'boards from DOM');
  }

  return boards;
}

function extractPins(): ActivePin[] {
  const pins: ActivePin[] = [];
  const seen = new Set<string>();
  const origin = location.origin;

  console.log(`[Pinterest Pins DOM] Extracting pins from page...`);

  const json = getPwsData();
  if (json) {
    // Search in resourceResponses
    if (json?.props?.initialReduxState?.resourceResponses) {
      collectFromObject(json.props.initialReduxState.resourceResponses, (item) => {
        const pinId = item?.id;
        const imageUrl = item?.images?.orig?.url || item?.images?.['736x']?.url || item?.image_large_url;
        if (!pinId || !imageUrl) return;
        if (seen.has(String(pinId))) return;
        seen.add(String(pinId));
        pins.push({
          pinId: String(pinId),
          title: item?.title || item?.grid_title || '',
          description: item?.description,
          imageUrl: String(imageUrl),
          pinUrl: `${origin}/pin/${pinId}/`
        });
      });
    }

    // Search in pins object
    const reduxPins = json?.props?.initialReduxState?.pins;
    if (reduxPins && typeof reduxPins === 'object') {
      for (const key of Object.keys(reduxPins)) {
        const item = reduxPins[key];
        if (!item || typeof item !== 'object') continue;
        const pinId = item?.id || key;
        const imageUrl = item?.images?.orig?.url || item?.images?.['736x']?.url || item?.image_large_url;
        if (!pinId || !imageUrl) continue;
        if (seen.has(String(pinId))) continue;
        seen.add(String(pinId));
        pins.push({
          pinId: String(pinId),
          title: item?.title || item?.grid_title || '',
          description: item?.description,
          imageUrl: String(imageUrl),
          pinUrl: `${origin}/pin/${pinId}/`
        });
      }
    }

    console.log(`[Pinterest Pins DOM] Found ${pins.length} pins from __PWS_DATA__`);
  }

  // DOM fallback - look for pin links with images
  if (pins.length === 0) {
    console.log(`[Pinterest Pins DOM] No pins from __PWS_DATA__, trying DOM extraction...`);

    // Look for pin containers
    const pinContainers = document.querySelectorAll('[data-test-id*="pin"], [data-grid-item], div[role="listitem"]');
    console.log(`[Pinterest Pins DOM] Found ${pinContainers.length} potential pin containers`);

    pinContainers.forEach((container) => {
      const anchor = container.querySelector('a[href*="/pin/"]') as HTMLAnchorElement;
      if (!anchor) return;

      const match = anchor.href.match(/\/pin\/(\d+)/);
      if (!match) return;

      const pinId = match[1];
      if (seen.has(pinId)) return;

      const img = container.querySelector('img') as HTMLImageElement | null;
      const src = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      if (!src) return;

      seen.add(pinId);
      pins.push({
        pinId,
        title: img?.alt || '',
        imageUrl: src,
        pinUrl: `${origin}/pin/${pinId}/`
      });
    });

    // Broader search if still no pins
    if (pins.length === 0) {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/pin/"]');
      anchors.forEach((anchor) => {
        const match = anchor.href.match(/\/pin\/(\d+)/);
        if (!match) return;
        const pinId = match[1];
        if (seen.has(pinId)) return;

        // Look for image in the anchor or nearby
        const img = anchor.querySelector('img') || anchor.closest('div')?.querySelector('img');
        const src = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        if (!src || src.includes('avatar')) return; // Skip avatar images

        seen.add(pinId);
        pins.push({
          pinId,
          title: (img as HTMLImageElement)?.alt || '',
          imageUrl: src,
          pinUrl: `${origin}/pin/${pinId}/`
        });
      });
    }

    console.log(`[Pinterest Pins DOM] Found ${pins.length} pins from DOM`);
  }

  return pins;
}

async function scrollForBoards(scrolls = 8): Promise<void> {
  for (let i = 0; i < scrolls; i++) {
    window.scrollBy(0, window.innerHeight * 0.85);
    await sleep(700);
  }
  window.scrollTo(0, 0);
}

async function scrollForPins(scrolls = 12): Promise<void> {
  for (let i = 0; i < scrolls; i++) {
    window.scrollBy(0, window.innerHeight * 0.85);
    await sleep(800);
  }
  window.scrollTo(0, 0);
}

async function scrollUntilStable(getCount: () => number, maxSeconds = 90, stableCycles = 6): Promise<void> {
  let lastHeight = document.body.scrollHeight;
  let lastCount = getCount();
  let stable = 0;
  const start = Date.now();

  while ((Date.now() - start) / 1000 < maxSeconds) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1200);

    const currentHeight = document.body.scrollHeight;
    const currentCount = getCount();

    if (currentHeight === lastHeight && currentCount === lastCount) {
      stable += 1;
    } else {
      stable = 0;
      lastHeight = currentHeight;
      lastCount = currentCount;
    }

    if (stable >= stableCycles) {
      break;
    }
  }

  window.scrollTo(0, 0);
}

async function extractBoardsWithScroll(username: string, rounds = 10, deepSync = false): Promise<ActiveBoard[]> {
  // First try to extract without scrolling - page data might already be loaded
  let boards = extractBoards(username);
  console.log(`[Pinterest DOM] Initial extraction found ${boards.length} boards`);

  // Do a few quick scrolls to load more boards
  let bestBoards = boards;
  const maxScrolls = deepSync ? 10 : 5;

  for (let i = 0; i < maxScrolls; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(600);

    boards = extractBoards(username);
    console.log(`[Pinterest DOM] Scroll ${i + 1}: found ${boards.length} boards`);

    if (boards.length > bestBoards.length) {
      bestBoards = boards;
    }

    // If we haven't found new boards in 2 scrolls, stop
    if (boards.length === bestBoards.length && i > 1) {
      break;
    }
  }

  window.scrollTo(0, 0);
  console.log(`[Pinterest DOM] Final result: returning ${bestBoards.length} boards`);
  return bestBoards;
}

async function extractPinsWithScroll(rounds = 20, deepSync = false): Promise<ActivePin[]> {
  // First try to extract without scrolling - page data might already be loaded
  let pins = extractPins();
  console.log(`[Pinterest Pins] Initial extraction found ${pins.length} pins`);

  // Quick mode: just do 2-3 fast scrolls to load more content
  if (!deepSync) {
    for (let i = 0; i < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(500);
      const newPins = extractPins();
      if (newPins.length > pins.length) {
        pins = newPins;
      }
    }
    window.scrollTo(0, 0);
    console.log(`[Pinterest Pins] Quick scroll found ${pins.length} pins total`);
    return pins;
  }

  // Deep sync mode - more thorough scrolling
  let lastCount = pins.length;
  let stableRounds = 0;
  let bestPins = pins;

  const maxRounds = Math.min(rounds, 15); // Cap at 15 rounds
  for (let i = 0; i < maxRounds; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(600);

    pins = extractPins();
    if (pins.length > bestPins.length) {
      bestPins = pins;
    }

    if (pins.length === lastCount) {
      stableRounds++;
      if (stableRounds >= 2) break; // Stop early if no new pins
    } else {
      stableRounds = 0;
      lastCount = pins.length;
    }
  }

  window.scrollTo(0, 0);
  console.log(`[Pinterest Pins] Deep scroll found ${bestPins.length} pins total`);
  return bestPins;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PINTEREST_ACTIVE_SET_PROGRESS') {
    const percent = typeof message.percent === 'number' ? message.percent : 0;
    const text = message.text || 'OpenMemory: Syncing your boards...';
    setProgress(percent, text, !!message.done);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_DETECT_USERNAME') {
    const result = extractUsername();
    sendResponse(result);
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_EXTRACT_BOARDS') {
    const username = message.username as string;
    const deepSync = !!message.deepSync;
    (async () => {
      const boards = await extractBoardsWithScroll(username, 10, deepSync);
      sendResponse({ boards });
    })();
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_EXTRACT_PINS') {
    const deepSync = !!message.deepSync;
    (async () => {
      const pins = await extractPinsWithScroll(14, deepSync);
      sendResponse({ pins });
    })();
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_FETCH_BOARDS') {
    const username = message.username as string;
    const deepSync = !!message.deepSync;
    (async () => {
      const logs: string[] = [];
      const log = (msg: string) => {
        console.log(msg);
        logs.push(msg);
      };

      let boards: ActiveBoard[] = [];
      let error: string | undefined;

      log(`[Pinterest] Starting board fetch for: ${username}`);
      log(`[Pinterest] Current URL: ${location.href}`);
      log(`[Pinterest] Origin: ${location.origin}`);
      log(`[Pinterest] CSRF token: ${getCsrfToken() ? 'present' : 'MISSING'}`);
      log(`[Pinterest] Cookies: ${document.cookie.substring(0, 100)}...`);

      // Check if we have __PWS_DATA__
      const pwsData = getPwsData();
      log(`[Pinterest] __PWS_DATA__ present: ${!!pwsData}`);
      if (pwsData) {
        log(`[Pinterest] PWS keys: ${Object.keys(pwsData).join(', ')}`);
        if (pwsData.props) {
          log(`[Pinterest] props keys: ${Object.keys(pwsData.props).join(', ')}`);
        }
      }

      try {
        const apiResult = await fetchBoardsApi(username);
        boards = apiResult.boards || [];
        error = apiResult.error;
        log(`[Pinterest] API result: ${boards.length} boards, error: ${error || 'none'}`);
      } catch (e) {
        error = e instanceof Error ? e.message : 'Boards API failed';
        log(`[Pinterest] API exception: ${error}`);
      }

      if (boards.length === 0) {
        log(`[Pinterest] API failed, trying DOM extraction...`);
        boards = await extractBoardsWithScroll(username, 12, deepSync);
        log(`[Pinterest] DOM extraction completed: ${boards.length} boards`);
      }

      if (boards.length > 0) {
        log(`[Pinterest] SUCCESS! Found ${boards.length} boards:`);
        boards.forEach((b, i) => log(`  ${i + 1}. "${b.name}" (id: ${b.boardId}, url: ${b.url})`));
      } else {
        log(`[Pinterest] FAILED: No boards found via API or DOM`);
      }

      sendResponse({ boards, error, logs });
    })();
    return true;
  }

  if (message.type === 'PINTEREST_ACTIVE_FETCH_PINS') {
    const boardId = message.boardId as string | undefined;
    const boardUrl = message.boardUrl as string | undefined;
    const deepSync = !!message.deepSync;
    (async () => {
      let pins: ActivePin[] = [];
      let error: string | undefined;

      console.log(`[Pinterest Pins] Fetching pins for board: ${boardId}, url: ${boardUrl}`);
      console.log(`[Pinterest Pins] Current page URL: ${location.href}`);

      // Only try API if we have a numeric board ID (not a slug)
      if (boardId && boardUrl && !boardId.startsWith('slug:')) {
        try {
          console.log(`[Pinterest Pins] Trying API with board_id: ${boardId}`);
          const apiResult = await fetchPinsApi(boardId, boardUrl);
          pins = apiResult.pins || [];
          error = apiResult.error;
          console.log(`[Pinterest Pins] API returned ${pins.length} pins, error: ${error || 'none'}`);
        } catch (e) {
          error = e instanceof Error ? e.message : 'Pins API failed';
          console.log(`[Pinterest Pins] API exception: ${error}`);
        }
      } else {
        console.log(`[Pinterest Pins] Skipping API (slug-based board ID), using DOM extraction`);
      }

      // DOM extraction fallback
      if (pins.length === 0) {
        console.log(`[Pinterest Pins] Extracting pins from DOM...`);
        pins = await extractPinsWithScroll(deepSync ? 20 : 12, deepSync);
        console.log(`[Pinterest Pins] DOM extraction found ${pins.length} pins`);
      }

      sendResponse({ pins, error });
    })();
    return true;
  }

  return false;
});
