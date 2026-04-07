/**
 * Supabase Search - Exact port of extension search logic
 * Mirrors src/extension/search.ts for consistent results
 */

import { generateQueryEmbedding } from './embeddings.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghfybenvdenuupiqgouf.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZnliZW52ZGVudXVwaXFnb3VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NTgwNDIsImV4cCI6MjA5MDIzNDA0Mn0._ADsqO0uFMEwNJ1lTKc3_0sBuuN3Jvxa3-naDmdYK1k';

const requestHeaders = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};

interface SupabaseBookmark {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  similarity?: number;
  created_at?: string | null;
}

interface SupabasePin {
  pin_id?: string;
  id?: string;
  pin_url: string;
  title: string | null;
  board_name: string | null;
  image_url: string | null;
  similarity?: number;
  similarity_raw?: number;
  description?: string | null;
  synced_at?: string | null;
}

interface SupabaseSearchResult {
  source: 'chrome' | 'pinterest';
  item_id: string;
  url: string;
  title: string;
  folder_or_board: string | null;
  image_url: string | null;
  similarity: number;
  keyword_score: number;
  similarity_raw?: number;
  description?: string | null;
  created_at?: string | null;
}

interface SearchResult {
  title: string;
  url: string;
  folder: string | null;
  source: string;
  score: number;
  imageUrl: string | null;
}

/**
 * Compute keyword score based on actual text matching
 * Exact same logic as extension
 */
function computeLocalKeywordScore(
  query: string,
  title: string | null,
  folder: string | null,
  url: string | null
): number {
  const queryLower = query.toLowerCase().trim();

  // Require minimum 2 characters for meaningful keyword matching
  if (queryLower.length < 2) return 0;

  const titleLower = (title || '').toLowerCase();
  const folderLower = (folder || '').toLowerCase();
  const urlLower = (url || '').toLowerCase();

  // Only give keyword score if the query actually appears in the text
  if (titleLower === queryLower) return 1.0;
  if (titleLower.includes(queryLower)) return 0.8;
  if (folderLower.includes(queryLower)) return 0.6;
  if (urlLower.includes(queryLower)) return 0.4;
  return 0; // No match = no keyword score
}

/**
 * Text search for bookmarks - with client-side filtering
 */
async function searchSupabaseText(
  query: string,
  limit: number,
  folder?: string
): Promise<SupabaseBookmark[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_bookmarks_text`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        p_search_query: query.trim(),
        p_match_count: limit,
        p_filter_folder: folder || null
      })
    });

    if (!response.ok) {
      console.error('[Search] Text search_bookmarks_text failed:', response.status);
      return [];
    }

    const rawResults = await response.json();

    // CLIENT-SIDE FILTER: Only keep results that actually contain the query
    const queryLower = query.trim().toLowerCase();
    const filteredResults = rawResults.filter((r: SupabaseBookmark) => {
      const titleMatch = (r.title || '').toLowerCase().includes(queryLower);
      const urlMatch = (r.url || '').toLowerCase().includes(queryLower);
      const folderMatch = (r.folder || '').toLowerCase().includes(queryLower);
      return titleMatch || urlMatch || folderMatch;
    });

    // Assign proper similarity scores based on match type
    const scoredResults = filteredResults.map((r: SupabaseBookmark) => {
      const titleLower = (r.title || '').toLowerCase();
      const urlLower = (r.url || '').toLowerCase();
      const folderLower = (r.folder || '').toLowerCase();

      let similarity = 0.3;
      if (titleLower === queryLower) {
        similarity = 1.0;
      } else if (titleLower.includes(queryLower)) {
        similarity = 0.8;
      } else if (folderLower.includes(queryLower)) {
        similarity = 0.6;
      } else if (urlLower.includes(queryLower)) {
        similarity = 0.4;
      }

      return { ...r, similarity };
    });

    // Sort by similarity
    scoredResults.sort((a: SupabaseBookmark, b: SupabaseBookmark) => (b.similarity || 0) - (a.similarity || 0));

    return scoredResults;
  } catch (err) {
    console.error('[Search] Text search exception:', err);
    return [];
  }
}

/**
 * Text search for Pinterest pins
 */
async function searchSupabasePinsText(
  query: string,
  limit: number,
  board?: string | null
): Promise<SupabasePin[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_pinterest_pins_text`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        search_query: query,
        match_count: limit,
        filter_board: board || null
      })
    });

    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

/**
 * Vector search for bookmarks
 */
async function searchBookmarksVector(
  embedding: number[],
  limit: number,
  folder?: string
): Promise<SupabaseBookmark[]> {
  try {
    const embeddingStr = `[${embedding.join(',')}]`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_bookmarks`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        query_embedding: embeddingStr,
        match_count: limit,
        filter_folder: folder || null
      })
    });

    if (!response.ok) {
      console.error('[Search] Vector search_bookmarks failed:', response.status);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('[Search] Bookmark vector search error:', error);
    return [];
  }
}

/**
 * Vector search for Pinterest pins
 */
async function searchPinsVector(
  embedding: number[],
  limit: number,
  board?: string | null
): Promise<SupabasePin[]> {
  try {
    const embeddingStr = `[${embedding.join(',')}]`;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_pinterest_pins`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        query_embedding: embeddingStr,
        match_count: limit,
        filter_board: board || null
      })
    });

    if (!response.ok) {
      console.error('[Search] Vector search_pinterest_pins failed:', response.status);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('[Search] Pin vector search error:', error);
    return [];
  }
}

/**
 * Main search function - exact port of extension's searchSupabaseVector
 */
export async function searchSupabase(
  query: string,
  limit = 50,
  sourceFilter?: string,
  folder?: string,
  board?: string | null
): Promise<{ results: SearchResult[]; total: number; hasMore: boolean }> {
  console.log(`[Supabase Search] Query: "${query}", limit: ${limit}, source: ${sourceFilter || 'all'}`);

  const isChrome = sourceFilter === 'chrome' || sourceFilter === 'chrome_bookmarks';
  const isPinterest = sourceFilter === 'pinterest';

  // Run text search and embedding generation in parallel (same as extension)
  const embeddingPromise = generateQueryEmbedding(query);
  const textSearchPromise = Promise.all([
    !isPinterest ? searchSupabaseText(query, limit, folder) : Promise.resolve([]),
    !isChrome ? searchSupabasePinsText(query, limit, board) : Promise.resolve([])
  ]);

  const [embedding, [bookmarkTextResults, pinTextResults]] = await Promise.all([
    embeddingPromise,
    textSearchPromise
  ]);

  console.log(`[Supabase Search] Text results - Bookmarks: ${bookmarkTextResults.length}, Pins: ${pinTextResults.length}`);

  // Convert text search results with local keyword scoring (same as extension)
  const textResults: SupabaseSearchResult[] = [
    ...bookmarkTextResults.map(b => ({
      source: 'chrome' as const,
      item_id: b.id,
      url: b.url,
      title: b.title,
      folder_or_board: b.folder,
      image_url: null,
      similarity: 0.5,
      keyword_score: computeLocalKeywordScore(query, b.title, b.folder, b.url),
      created_at: b.created_at ?? null
    })),
    ...pinTextResults.map(p => ({
      source: 'pinterest' as const,
      item_id: p.pin_id ?? p.id ?? '',
      url: p.pin_url,
      title: p.title || 'Untitled',
      folder_or_board: p.board_name || null,
      image_url: p.image_url || null,
      similarity: 0.5,
      keyword_score: computeLocalKeywordScore(query, p.title, p.board_name, p.pin_url),
      description: p.description || null,
      created_at: p.synced_at ?? null
    }))
  ].filter(r => r.keyword_score > 0); // Only keep actual matches!

  // If no embedding, return text results only
  if (!embedding) {
    console.log('[Supabase Search] No embedding, using text search only');
    const results = textResults.slice(0, limit).map(r => toSearchResult(r));
    return { results, total: results.length, hasMore: textResults.length > limit };
  }

  // Do vector search in parallel
  const [bookmarkVectorResults, pinVectorResults] = await Promise.all([
    !isPinterest ? searchBookmarksVector(embedding, limit, folder) : Promise.resolve([]),
    !isChrome ? searchPinsVector(embedding, limit, board) : Promise.resolve([])
  ]);

  console.log(`[Supabase Search] Vector results - Bookmarks: ${bookmarkVectorResults.length}, Pins: ${pinVectorResults.length}`);

  // Convert vector search results (same as extension)
  const vectorResults: SupabaseSearchResult[] = [
    ...bookmarkVectorResults.map(b => ({
      source: 'chrome' as const,
      item_id: b.id,
      url: b.url,
      title: b.title,
      folder_or_board: b.folder,
      image_url: null,
      similarity: b.similarity || 0,
      keyword_score: 0,
      created_at: b.created_at ?? null
    })),
    ...pinVectorResults.map(p => ({
      source: 'pinterest' as const,
      item_id: p.pin_id ?? p.id ?? '',
      url: p.pin_url,
      title: p.title || 'Untitled',
      folder_or_board: p.board_name || null,
      image_url: p.image_url || null,
      similarity: typeof p.similarity_raw === 'number' ? 1 - p.similarity_raw : (p.similarity || 0),
      similarity_raw: p.similarity_raw,
      keyword_score: 0,
      description: p.description || null,
      created_at: p.synced_at ?? null
    }))
  ];

  // Merge results: text matches first, then vector matches (dedupe by URL)
  // Same logic as extension
  const seenUrls = new Set<string>();
  const mergedResults: SupabaseSearchResult[] = [];

  // Add text results first (keyword matches have priority)
  for (const result of textResults) {
    if (!seenUrls.has(result.url)) {
      seenUrls.add(result.url);
      mergedResults.push(result);
    }
  }

  // Add vector results that weren't already in text results
  for (const result of vectorResults) {
    if (!seenUrls.has(result.url)) {
      seenUrls.add(result.url);
      mergedResults.push(result);
    } else {
      // Update existing result with vector similarity if it has a text match
      const existing = mergedResults.find(r => r.url === result.url);
      if (existing && result.similarity > (existing.similarity || 0)) {
        existing.similarity = result.similarity;
        existing.similarity_raw = result.similarity_raw;
      }
    }
  }

  // Sort: keyword matches first, then by similarity (same as extension)
  mergedResults.sort((a, b) => {
    const keywordDiff = (b.keyword_score || 0) - (a.keyword_score || 0);
    if (keywordDiff !== 0) return keywordDiff;
    return (b.similarity || 0) - (a.similarity || 0);
  });

  const finalResults = mergedResults.slice(0, limit).map(r => toSearchResult(r));

  console.log(`[Supabase Search] Final results: ${finalResults.length}`);

  return {
    results: finalResults,
    total: finalResults.length,
    hasMore: mergedResults.length > limit
  };
}

/**
 * Convert internal result to API response format
 */
function toSearchResult(r: SupabaseSearchResult): SearchResult {
  // Calculate combined score for sorting
  const score = r.keyword_score > 0
    ? 0.3 + (0.7 * r.keyword_score)
    : 0.1 + (0.4 * (r.similarity || 0));

  // Generate image URL
  let imageUrl: string | null = r.image_url;
  if (!imageUrl && r.source === 'chrome') {
    try {
      const domain = new URL(r.url).hostname;
      imageUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch {}
  }

  return {
    title: r.title,
    url: r.url,
    folder: r.folder_or_board,
    source: r.source,
    score,
    imageUrl
  };
}
