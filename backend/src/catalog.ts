/**
 * Cached read paths shared by the REST routes and the MCP endpoint, so both
 * return the same results and reuse the same Redis keys.
 */
import { searchSupabase, getSupabaseFolders, getSupabaseBoards } from './supabase-search.js';
import { searchXBookmarks } from './x-bookmarks.js';
import { getCache, setCache } from './redis.js';
import type { SearchResult } from './search.js';

const TTL = {
  SEARCH: 600,    // 10 min — search results
  FOLDERS: 3600,  // 1 hr — folder list rarely changes
  BOARDS: 86400,  // 24 hr — board list rarely changes
};

export type CatalogResult = Omit<SearchResult, 'intent'> & { description?: string; author?: string };
export interface CatalogSearch { results: CatalogResult[]; total: number; hasMore: boolean }

const EMPTY: CatalogSearch = { results: [], total: 0, hasMore: false };

/** Hybrid search across bookmarks, Pinterest pins and X bookmarks. */
export async function searchAll(query: string, limit: number, source?: string, folder?: string, board?: string): Promise<CatalogSearch> {
  // folder/board belong in the key: the same query scoped to a different
  // collection is a different result set.
  const cacheKey = `search:${query.toLowerCase().trim()}:${source ?? 'all'}:${folder ?? ''}:${board ?? ''}:${limit}`;
  const includesX = source === 'x' || ((!source || source === 'all') && !folder && !board);
  const cached = includesX ? null : await getCache<CatalogSearch>(cacheKey);
  if (cached) return cached;

  const [existing, x] = await Promise.all([
    source === 'x' ? Promise.resolve(EMPTY) : searchSupabase(query, limit, source, folder, board) as Promise<CatalogSearch>,
    includesX ? searchXBookmarks(query, limit).catch((error): CatalogSearch => {
      if (source === 'x') throw error;
      console.warn('[X search] unavailable:', error instanceof Error ? error.message : 'request failed');
      return EMPTY;
    }) : Promise.resolve(EMPTY),
  ]);
  const results = [...existing.results, ...x.results].sort((a, b) => b.score - a.score).slice(0, limit);
  const result = { results, total: existing.total + x.total, hasMore: existing.hasMore || existing.total + x.total > limit };
  if (!includesX) await setCache(cacheKey, result, TTL.SEARCH);
  return result;
}

export async function listFolders(): Promise<string[]> {
  const cached = await getCache<string[]>('folders:v2');
  if (cached) return cached;
  const folders = await getSupabaseFolders();
  await setCache('folders:v2', folders, TTL.FOLDERS);
  return folders;
}

export async function listBoards(): Promise<string[]> {
  const cached = await getCache<string[]>('boards');
  if (cached) return cached;
  const boards = await getSupabaseBoards();
  await setCache('boards', boards, TTL.BOARDS);
  return boards;
}
