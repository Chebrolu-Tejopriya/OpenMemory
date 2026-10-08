import { PINTEREST_IMPORT_LIMIT } from './pinterest-import-policy';

export interface FeedPin {
  pinId: string;
  pinUrl: string;
  imageUrl: string;
  title: string;
  description?: string;
  source: 'pinterest';
  type: 'image';
}

export function mergeFeedPin(existing: FeedPin, incoming: FeedPin): void {
  // Preserve metadata already collected; enrich incomplete DOM records from the feed.
  if (incoming.imageUrl) existing.imageUrl = incoming.imageUrl;
  if (incoming.title) existing.title = incoming.title;
  if (incoming.description) existing.description = incoming.description;
  existing.pinUrl = incoming.pinUrl;
}

export function parseFeedPins(data: unknown): FeedPin[] {
  const pins: FeedPin[] = [];
  const visit = (value: any, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 15) return;
    if (/^\d+$/.test(String(value.id)) && (value.type === 'pin' || value.images)) {
      const image = ['orig', '736x', '564x', '474x', '236x'].map(key => value.images?.[key]?.url)
        .find(url => typeof url === 'string' && /^https?:\/\//.test(url));
      pins.push({ pinId: String(value.id), pinUrl: `https://www.pinterest.com/pin/${value.id}/`,
        imageUrl: image || '', title: value.title || value.grid_title || value.description || '',
        description: value.description || value.closeup_description || '', source: 'pinterest', type: 'image' });
      return; // Do not import nested related pins or the owning board's thumbnail.
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };
  visit(data);
  return pins;
}

interface FeedResult {
  pins: FeedPin[];
  expectedCount: number | null;
  boardName?: string;
  finished: boolean;
  pages: number;
  error?: string;
}

// API protocol reference: sean1832/pinterest-dl. Independent TypeScript implementation.
// Run on the Pinterest tab: same-origin requests use its session without exporting cookies.
export async function fetchBoardFeed(
  boardUrl: string,
  maxPins = PINTEREST_IMPORT_LIMIT,
  onProgress: (count: number, expected: number | null) => void = () => {},
  request: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<FeedResult> {
  const result: FeedResult = { pins: [], expectedCount: null, finished: false, pages: 0 };
  const pins = new Map<string, FeedPin>();
  const url = new URL(boardUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  if (!/(^|\.)pinterest\.com$/.test(url.hostname) || segments.length !== 2 || ['pin', 'search', 'ideas'].includes(segments[0])) {
    return { ...result, error: 'Open a Pinterest board, rather than a pin or profile.' };
  }
  const source = `/${segments[0]}/${segments[1]}/`;
  const resource = async (name: string, options: Record<string, unknown>, allowEmpty = false): Promise<any> => {
    let lastError = 'Pinterest returned an empty feed.';
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const endpoint = new URL(`/resource/${name}/get/`, url.origin);
        endpoint.searchParams.set('source_url', source);
        endpoint.searchParams.set('data', JSON.stringify({ options, context: {} }));
        const response = await request(endpoint.toString(), { credentials: 'include', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-PWS-Handler': 'www/pin/[id].js' } });
        if (!response.ok) {
          lastError = `Pinterest request failed (${response.status}).`;
          if (response.status === 401 || response.status === 403) throw new Error(`${lastError} Check your Pinterest login.`);
          throw new Error(lastError);
        }
        const json = await response.json();
        const body = json?.resource_response;
        if (!body || body.error || body.status === 'failure') throw new Error('Pinterest returned an invalid feed response.');
        const cursor = getBookmarks(json);
        if (!allowEmpty && Array.isArray(body.data) && !body.data.length && !cursor.includes('-end-')) {
          throw new Error('Pinterest returned an empty page before the end of the feed.');
        }
        return json;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Pinterest request failed.';
        if (lastError.includes('Check your Pinterest login')) throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < 2) await wait(1000 * 2 ** attempt);
    }
    throw new Error(lastError);
  };
  const collect = (json: any): void => {
    for (const pin of parseFeedPins(json.resource_response.data)) {
      const existing = pins.get(pin.pinId);
      if (existing) mergeFeedPin(existing, pin);
      else if (pins.size < maxPins) pins.set(pin.pinId, pin);
    }
    onProgress(pins.size, result.expectedCount);
  };
  const paginate = async (name: string, options: Record<string, unknown>): Promise<void> => {
    let bookmarks: string[] = [];
    const seenCursors = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const json = await resource(name, { ...options, page_size: 50, bookmarks });
      result.pages++;
      collect(json);
      const next = getBookmarks(json);
      if (next.includes('-end-')) return;
      if (pins.size >= maxPins) throw new Error(`Reached the ${maxPins}-pin safety limit.`);
      const key = JSON.stringify(next);
      if (!next.length || seenCursors.has(key)) throw new Error('Pinterest pagination stopped without an end marker.');
      seenCursors.add(key);
      bookmarks = next;
      await wait(250);
    }
    throw new Error('Reached the pagination safety limit.');
  };
  try {
    const board = (await resource('BoardResource', { username: decodeURIComponent(segments[0]), slug: decodeURIComponent(segments[1]), field_set_key: 'detailed' }, true)).resource_response.data;
    if (!/^\d+$/.test(String(board?.id))) throw new Error('Pinterest did not return a board ID.');
    result.expectedCount = typeof board.pin_count === 'number' ? board.pin_count : null;
    result.boardName = board.name;
    await paginate('BoardFeedResource', { board_id: String(board.id), board_url: source, field_set_key: 'react_grid_pin',
      currentFilter: -1, filter_section_pins: true, sort: 'default', layout: 'default', redux_normalize_feed: true });
    // Board feeds may omit pins filed in sections; enumerate those explicitly.
    const sections: any[] = [];
    let sectionBookmarks: string[] = [];
    const sectionCursors = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const json = await resource('BoardSectionsResource', { board_id: String(board.id), bookmarks: sectionBookmarks }, true);
      if (!Array.isArray(json.resource_response.data)) throw new Error('Pinterest did not return a valid section list.');
      sections.push(...json.resource_response.data);
      const next = getBookmarks(json);
      if (!next.length || next.includes('-end-')) break;
      const key = JSON.stringify(next);
      if (sectionCursors.has(key) || page === 199) throw new Error('Pinterest section pagination stalled.');
      sectionCursors.add(key);
      sectionBookmarks = next;
      await wait(250);
    }
    for (const section of sections) {
      if (!/^\d+$/.test(String(section.id))) continue;
      await paginate('BoardSectionPinsResource', { section_id: String(section.id), field_set_key: 'react_grid_pin', redux_normalize_feed: true });
    }
    result.finished = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Pinterest feed failed.';
  }
  result.pins = Array.from(pins.values());
  return result;
}

function getBookmarks(json: any): string[] {
  const value = json?.resource_response?.bookmark ?? json?.resource_response?.bookmarks ?? json?.resource?.options?.bookmarks;
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((cursor): cursor is string => typeof cursor === 'string' && cursor.length > 0);
}
