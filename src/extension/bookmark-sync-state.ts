// Decides which bookmarks a sync actually has to write.
//
// Every write to `bookmarks` rewrites the row and its vector index entry, so
// re-sending rows that have not changed is what exhausted the database's disk
// budget. A sync must compare first and write only the difference.

export interface BookmarkSyncInput {
  url: string;
  title: string;
  folder: string | null;
  chrome_id?: string;
}

export interface StoredBookmark {
  title: string;
  folder: string | null;
  chrome_id: string | null;
}

export interface BookmarkSyncState {
  /** Every bookmark row in the cloud, keyed by URL. */
  rows: Map<string, StoredBookmark>;
  /** URLs whose row exists but has no embedding yet. */
  missingEmbedding: Set<string>;
}

export interface BookmarkWritePlan {
  /** Send an upsert for this bookmark. */
  write: boolean;
  /** Generate a fresh embedding as part of that upsert. */
  embed: boolean;
}

export function planBookmarkWrite(
  bookmark: BookmarkSyncInput,
  stored: StoredBookmark | undefined,
  hasEmbedding: boolean,
  forceEmbedding = false,
): BookmarkWritePlan {
  if (!stored) return { write: true, embed: true };
  const embed = forceEmbedding || stored.title !== bookmark.title || !hasEmbedding;
  const sameMetadata = (stored.folder ?? null) === (bookmark.folder ?? null)
    && (stored.chrome_id ?? null) === (bookmark.chrome_id || null);
  return { write: embed || !sameMetadata, embed };
}

async function fetchAll<T>(
  config: { url: string; anonKey: string },
  query: Record<string, string>,
  fetcher: typeof fetch,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({ ...query, order: 'id.asc', limit: '1000', offset: String(offset) });
    const response = await fetcher(`${config.url.replace(/\/$/, '')}/rest/v1/bookmarks?${params}`, {
      method: 'GET',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Bookmark sync state unavailable (${response.status})`);
    const page: T[] = await response.json();
    if (page.length === 0) return all;
    all.push(...page);
    // Advance by what was returned: the server may cap pages below the limit.
    offset += page.length;
  }
}

/**
 * Snapshot of what the cloud already holds, in a few read-only requests.
 * Never selects the embedding column itself — only whether it is missing.
 */
export async function fetchBookmarkSyncState(
  config: { url: string; anonKey: string },
  fetcher: typeof fetch = fetch,
): Promise<BookmarkSyncState> {
  const [stored, missing] = await Promise.all([
    fetchAll<StoredBookmark & { url: string }>(config, { select: 'url,title,folder,chrome_id' }, fetcher),
    fetchAll<{ url: string }>(config, { select: 'url', embedding: 'is.null' }, fetcher),
  ]);
  return {
    rows: new Map(stored.map(row => [row.url, { title: row.title, folder: row.folder, chrome_id: row.chrome_id }])),
    missingEmbedding: new Set(missing.map(row => row.url)),
  };
}
