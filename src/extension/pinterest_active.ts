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

  while (rounds < 40) {
    const data = {
      options: {
        username,
        field_set_key: 'detailed',
        page_size: 250,
        bookmarks: bookmark ? [bookmark] : []
      },
      context: {}
    };

    const url = `${location.origin}/resource/BoardsResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify(data))}`;
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
      return { boards, error: `BoardsResource HTTP ${response.status}` };
    }
    const json = await response.json();
    const dataList = json?.resource_response?.data || json?.data || [];

    for (const item of dataList) {
      if (!item?.id || !item?.name || !item?.url) continue;
      const absoluteUrl = item.url.startsWith('http')
        ? item.url
        : `${location.origin}${item.url.startsWith('/') ? '' : '/'}${item.url}`;
      boards.push({
        boardId: String(item.id),
        name: String(item.name),
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

  return { boards };
}

async function fetchBoardsApi(username: string): Promise<{ boards: ActiveBoard[]; error?: string }> {
  const sources = [
    `/${username}/boards/`,
    `/${username}/_saved/`,
    `/${username}/`
  ];

  let lastError: string | undefined;
  for (const sourceUrl of sources) {
    const result = await fetchBoardsApiForSource(username, sourceUrl);
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
  const skipSlugs = new Set(['_saved', '_created', '_boards', '_pins', 'pin', 'search', 'ideas', 'today', 'settings', 'business', 'login']);

  const json = getPwsData();
  const resourceResponses = json?.props?.initialReduxState?.resourceResponses;
  if (resourceResponses) {
    collectFromObject(resourceResponses, (item) => {
      const boardId = item?.board_id || item?.id;
      const boardName = item?.name || item?.title;
      const boardUrl = item?.url;
      if (!boardId || !boardName || !boardUrl) return;
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

  const reduxBoards = json?.props?.initialReduxState?.boards;
  if (reduxBoards) {
    collectFromObject(reduxBoards, (item) => {
      const boardId = item?.board_id || item?.id;
      const boardName = item?.name || item?.title;
      const boardUrl = item?.url;
      if (!boardId || !boardName || !boardUrl) return;
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

  if (boards.length === 0) {
    const boardSelectors = [
      `a[data-test-id*="board"][href^="/${username}/"]`,
      `a[href^="/${username}/"][data-test-id*="board"]`,
      `a[href^="/${username}/"][aria-label*="Board"]`,
      `a[href^="/${username}/"]`
    ];
    const anchors = document.querySelectorAll<HTMLAnchorElement>(boardSelectors.join(','));
    anchors.forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!href.includes(`/${username}/`)) return;
      const parts = href.split('/').filter(Boolean);
      const slug = parts[parts.length - 1] || '';
      if (!slug || skipSlugs.has(slug.toLowerCase())) return;

      const absoluteUrl = normalizeBoardHost(href);
      if (seen.has(absoluteUrl)) return;
      seen.add(absoluteUrl);

      const label = anchor.getAttribute('aria-label') || '';
      const name = label || slug.replace(/-/g, ' ');
      if (name) {
        boards.push({ boardId: `slug:${slug}`, name, url: absoluteUrl });
      }
    });
  }

  return boards;
}

function extractPins(): ActivePin[] {
  const pins: ActivePin[] = [];
  const seen = new Set<string>();

  const json = getPwsData();
  if (json?.props?.initialReduxState?.resourceResponses) {
    collectFromObject(json.props.initialReduxState.resourceResponses, (item) => {
      const pinId = item?.id;
      const imageUrl = item?.images?.orig?.url;
      if (!pinId || !imageUrl) return;
      if (seen.has(String(pinId))) return;
      seen.add(String(pinId));
      pins.push({
        pinId: String(pinId),
        title: item?.title || '',
        description: item?.description,
        imageUrl: String(imageUrl),
        pinUrl: `https://www.pinterest.com/pin/${pinId}/`
      });
    });
  }

  const reduxPins = json?.props?.initialReduxState?.pins;
  if (reduxPins) {
    collectFromObject(reduxPins, (item) => {
      const pinId = item?.id;
      const imageUrl = item?.images?.orig?.url;
      if (!pinId || !imageUrl) return;
      if (seen.has(String(pinId))) return;
      seen.add(String(pinId));
      pins.push({
        pinId: String(pinId),
        title: item?.title || '',
        description: item?.description,
        imageUrl: String(imageUrl),
        pinUrl: `https://www.pinterest.com/pin/${pinId}/`
      });
    });
  }

  if (pins.length === 0) {
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/pin/"]');
    anchors.forEach((anchor) => {
      const match = anchor.href.match(/\/pin\/(\d+)/);
      if (!match) return;
      const pinId = match[1];
      if (seen.has(pinId)) return;
      const img = anchor.querySelector('img') as HTMLImageElement | null;
      const src = img?.getAttribute('src') || '';
      if (!src) return;
      seen.add(pinId);
      pins.push({
        pinId,
        title: img?.alt || '',
        imageUrl: src,
        pinUrl: `https://www.pinterest.com/pin/${pinId}/`
      });
    });
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
  if (deepSync) {
    await scrollUntilStable(() => extractBoards(username).length, 120, 6);
    return extractBoards(username);
  }

  let lastCount = 0;
  let stableRounds = 0;
  let boards: ActiveBoard[] = [];

  const maxRounds = Math.max(rounds, 10);
  for (let i = 0; i < maxRounds; i++) {
    await scrollForBoards(4);
    boards = extractBoards(username);
    if (boards.length === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = boards.length;
    }

    if (stableRounds >= 3) break;
    await sleep(800);
  }

  return boards;
}

async function extractPinsWithScroll(rounds = 20, deepSync = false): Promise<ActivePin[]> {
  let lastCount = 0;
  let stableRounds = 0;
  let pins: ActivePin[] = [];

  const maxRounds = deepSync ? Math.max(rounds, 30) : rounds;
  for (let i = 0; i < maxRounds; i++) {
    if (deepSync && i === 0) {
      await scrollUntilStable(() => extractPins().length, 90, 6);
    } else {
      await scrollForPins(deepSync ? 6 : 4);
    }
    pins = extractPins();
    if (pins.length === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      lastCount = pins.length;
    }

    if (stableRounds >= (deepSync ? 6 : 3)) break;
    await sleep(800);
  }

  return pins;
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
      let boards: ActiveBoard[] = [];
      let error: string | undefined;
      try {
        const apiResult = await fetchBoardsApi(username);
        boards = apiResult.boards || [];
        error = apiResult.error;
      } catch (e) {
        error = e instanceof Error ? e.message : 'Boards API failed';
      }

      if (boards.length === 0) {
        boards = await extractBoardsWithScroll(username, 12, deepSync);
      }

      sendResponse({ boards, error });
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

      if (boardId && boardUrl) {
        try {
          const apiResult = await fetchPinsApi(boardId, boardUrl);
          pins = apiResult.pins || [];
          error = apiResult.error;
        } catch (e) {
          error = e instanceof Error ? e.message : 'Pins API failed';
        }
      }

      if (pins.length === 0) {
        pins = await extractPinsWithScroll(16, deepSync);
      }

      sendResponse({ pins, error });
    })();
    return true;
  }

  return false;
});
