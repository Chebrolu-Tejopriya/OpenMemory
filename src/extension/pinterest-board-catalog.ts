const HIDDEN_BOARDS = new Set(['book art drawings', 'your profile', 'test board']);

export function collectPinterestBoardNames(...lists: Iterable<string | null | undefined>[]): string[] {
  const names = new Set<string>();
  for (const list of lists) {
    for (const name of list) {
      if (name?.trim() && !HIDDEN_BOARDS.has(name.trim().toLowerCase())) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Board metadata is enough for the menu. Do not download every pin or enqueue
// a sync just to show boards that are not stored on this computer.
export async function fetchPinterestBoardNames(
  config: { url: string; anonKey: string },
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const names: Array<string | null> = [];
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({ select: 'board_name', order: 'board_url.asc', limit: '1000', offset: String(offset) });
    const response = await fetcher(`${config.url.replace(/\/$/, '')}/rest/v1/pinterest_boards?${params}`, {
      method: 'GET',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Pinterest boards unavailable (${response.status})`);
    const page: Array<{ board_name: string | null }> = await response.json();
    if (page.length === 0) return collectPinterestBoardNames(names);
    names.push(...page.map(row => row.board_name));
    offset += page.length;
  }
}
