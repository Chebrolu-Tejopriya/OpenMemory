import type { IndexedBookmark } from './db';

export interface CloudBookmark {
  url: string;
  title: string;
  folder: string | null;
}

// This import contains the links that were originally saved in OM. Keep the
// stored path as the filter value; changing the label must not move any records.
export function bookmarkFolderLabel(path: string): string {
  return path.split('/').at(-1) === 'Recovered from Open Memory - 2026-11-07' ? 'OM' : path;
}

export async function fetchBookmarkCatalog(
  config: { url: string; anonKey: string },
  fetcher: typeof fetch = fetch,
): Promise<CloudBookmark[]> {
  const bookmarks: CloudBookmark[] = [];
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({ select: 'url,title,folder', order: 'id.asc', limit: '1000', offset: String(offset) });
    const response = await fetcher(`${config.url.replace(/\/$/, '')}/rest/v1/bookmarks?${params}`, {
      method: 'GET',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Bookmark catalog unavailable (${response.status})`);
    const page: CloudBookmark[] = await response.json();
    if (page.length === 0) return bookmarks;
    bookmarks.push(...page);
    // Advance by what the server returned: its row cap can be below our limit.
    offset += page.length;
  }
}

export function mergeBookmarkCatalog(local: IndexedBookmark[], cloud: CloudBookmark[]): IndexedBookmark[] {
  const merged = new Map(local.map(bookmark => [bookmark.url, bookmark]));
  cloud.forEach((bookmark, index) => {
    const existing = merged.get(bookmark.url);
    merged.set(bookmark.url, {
      ...existing,
      ...bookmark,
      id: existing?.id ?? -(index + 1),
      indexStatus: existing?.indexStatus ?? 'indexed',
    });
  });
  return [...merged.values()];
}
