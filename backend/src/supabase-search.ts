/**
 * Supabase Search - Exact port of extension search logic
 * Mirrors src/extension/search.ts for consistent results
 */

import { generateQueryEmbedding } from './embeddings.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghfybenvdenuupiqgouf.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZnliZW52ZGVudXVwaXFnb3VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NTgwNDIsImV4cCI6MjA5MDIzNDA0Mn0._ADsqO0uFMEwNJ1lTKc3_0sBuuN3Jvxa3-naDmdYK1k';

// Constants matching extension
const RECENT_DAYS = 30;
const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

// Performance optimization: Skip vector search if text results are strong enough
const STRONG_KEYWORD_THRESHOLD = 0.5; // Skip vector search if best keyword score >= this (lowered for speed)
const MIN_TEXT_RESULTS_TO_SKIP_VECTOR = 5; // Need at least this many text results to skip vector
const EMBEDDING_TIMEOUT_MS = 8000; // Max time to wait for embedding generation (increased for better results)

// LRU Cache for query embeddings (avoids regenerating for repeated queries)
const EMBEDDING_CACHE_SIZE = 100;
const embeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();

function getCachedEmbedding(query: string): number[] | null {
  const cached = embeddingCache.get(query.toLowerCase().trim());
  if (cached) {
    // Update timestamp for LRU
    cached.timestamp = Date.now();
    return cached.embedding;
  }
  return null;
}

function setCachedEmbedding(query: string, embedding: number[]): void {
  const key = query.toLowerCase().trim();

  // Evict oldest entries if cache is full
  if (embeddingCache.size >= EMBEDDING_CACHE_SIZE) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [k, v] of embeddingCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) embeddingCache.delete(oldestKey);
  }

  embeddingCache.set(key, { embedding, timestamp: Date.now() });
}

// Synonym map for query expansion (same as extension)
const synonymMap: Record<string, string[]> = {
  'dashboard': ['admin', 'panel', 'analytics', 'metrics'],
  'ui': ['interface', 'design', 'ux', 'user interface'],
  'ux': ['user experience', 'interface', 'ui'],
  'button': ['cta', 'action', 'click'],
  'landing': ['homepage', 'hero', 'marketing'],
  'mobile': ['app', 'ios', 'android', 'responsive'],
  'dark': ['night', 'mode', 'theme'],
  'light': ['bright', 'white', 'mode'],
  'card': ['tile', 'component', 'widget'],
  'form': ['input', 'field', 'submit'],
  'nav': ['navigation', 'menu', 'sidebar', 'header'],
  'menu': ['navigation', 'nav', 'dropdown'],
  'fintech': ['finance', 'banking', 'payment', 'crypto'],
  'finance': ['fintech', 'banking', 'money'],
  'ecommerce': ['shop', 'store', 'cart', 'product'],
  'saas': ['software', 'app', 'platform', 'tool'],
  'minimal': ['clean', 'simple', 'minimalist'],
  'modern': ['contemporary', 'sleek', 'fresh'],
  'gradient': ['colorful', 'vibrant'],
  'icon': ['symbol', 'glyph'],
  'table': ['grid', 'data', 'list'],
  'chart': ['graph', 'visualization', 'data'],
  'profile': ['user', 'account', 'avatar'],
  'settings': ['preferences', 'config', 'options'],
  'login': ['signin', 'auth', 'authentication'],
  'signup': ['register', 'onboarding', 'create account'],
};

/**
 * Expand query with synonyms (same as extension)
 */
function expandQuery(query: string): { original: string; expanded: string; terms: string[] } {
  const original = query.toLowerCase().trim();
  const words = original.split(/\s+/).filter(w => w.length > 0);
  const expandedTerms = new Set<string>(words);

  for (const word of words) {
    if (synonymMap[word]) {
      synonymMap[word].forEach(syn => expandedTerms.add(syn));
    }
  }

  return {
    original,
    expanded: Array.from(expandedTerms).join(' '),
    terms: Array.from(expandedTerms)
  };
}

/**
 * Tokenize query into terms
 */
function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => word.length > 0);
}

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
  recency_score: number;
  combined_score: number;
  similarity_raw?: number;
  description?: string | null;
  created_at?: string | null;
}

/**
 * Compute recency score (same as extension)
 * Items within RECENT_DAYS get higher scores
 */
function computeRecencyScore(createdAt: string | null | undefined): number {
  if (!createdAt) return 0;

  const timestamp = Date.parse(createdAt);
  if (isNaN(timestamp)) return 0;

  const now = Date.now();
  const ageMs = now - timestamp;
  const normalized = 1 - Math.min(ageMs / RECENT_WINDOW_MS, 1);
  return Math.max(0, normalized);
}

/**
 * Compute combined score (same formula as extension)
 * 0.55 * textScore + 0.10 * semanticScore + 0.15 * recencyScore + 0.20 * sourceBoost
 */
function computeCombinedScore(
  textScore: number,
  semanticScore: number,
  recencyScore: number,
  source: 'chrome' | 'pinterest'
): number {
  const sourceBoost = source === 'chrome' ? 1.0 : 0.0;
  return (
    (0.55 * textScore) +
    (0.10 * semanticScore) +
    (0.15 * recencyScore) +
    (0.20 * sourceBoost)
  );
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
 * Exact same logic as extension's computeTextMatchScore
 */
function computeLocalKeywordScore(
  query: string,
  title: string | null,
  folder: string | null,
  url: string | null,
  extraText?: string | null
): number {
  const terms = tokenizeQuery(query.toLowerCase().trim());
  if (!terms.length) return 0;

  const titleText = (title || '').toLowerCase();
  const boardText = (folder || '').toLowerCase();
  const extra = (extraText || '').toLowerCase();
  const urlText = (url || '').toLowerCase();
  const queryStr = terms.join(' ').trim();

  // Require minimum 2 characters for meaningful keyword matching
  if (queryStr.length < 2) return 0;

  // Exact title match (highest priority)
  if (titleText === queryStr) return 1.0;

  // Title contains full query
  if (titleText.includes(queryStr)) return 0.8;

  // URL contains full query (e.g., searching "omma" finds "omma.build")
  if (urlText.includes(queryStr)) return 0.75;

  // Expand query for better matching
  const { terms: expandedTerms } = expandQuery(queryStr);
  const allTerms = [...new Set([...terms, ...expandedTerms])];

  // Check how many terms match in title
  const titleWords = titleText.split(/\s+/);
  const titleTermHits = allTerms.filter(term =>
    term.length > 1 && (titleText.includes(term) || titleWords.some(w => w.startsWith(term)))
  ).length;
  const originalTermHits = terms.filter(term =>
    term.length > 1 && (titleText.includes(term) || titleWords.some(w => w.startsWith(term)))
  ).length;

  // All original terms found in title
  if (originalTermHits === terms.length && terms.length > 0) return 0.7;

  // Most original terms found (>50%)
  if (terms.length > 1 && originalTermHits / terms.length > 0.5) return 0.55;

  // URL contains any original term (e.g., "omma" in "omma.build")
  if (terms.some(term => term.length > 2 && urlText.includes(term))) return 0.5;

  // Board/folder contains query
  if (boardText.includes(queryStr)) return 0.4;

  // Board contains any original term
  if (terms.some(term => term.length > 2 && boardText.includes(term))) return 0.35;

  // Extra text (description) contains query
  if (extra && extra.includes(queryStr)) return 0.3;

  // Check expanded terms match in all text (including URL)
  const haystack = `${titleText} ${boardText} ${extra} ${urlText}`.trim();
  if (titleTermHits > 0) {
    // Score based on how many expanded terms match
    const matchRatio = titleTermHits / Math.max(allTerms.length, 1);
    return Math.min(0.25, 0.1 + (matchRatio * 0.15));
  }

  // Any term found anywhere (including URL)
  const anyHit = allTerms.some(term => term.length > 2 && haystack.includes(term));
  if (anyHit) return 0.15;

  return 0;
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
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_bookmarks_text?select=id,url,title,folder,similarity,created_at`, {
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
 * Text search for Pinterest pins — direct PostgREST query, no RPC needed.
 * Builds an OR filter across title, description, and board_name for each term.
 */
async function searchSupabasePinsText(
  query: string,
  limit: number,
  board?: string | null
): Promise<SupabasePin[]> {
  if (!query || query.trim().length === 0) return [];

  try {
    const terms = query.trim().split(/\s+/).filter(w => w.length > 1);
    if (terms.length === 0) return [];

    // For each term, require it appears in title OR description OR board_name.
    // With multiple terms, ALL must match somewhere (AND between terms, OR within columns).
    // Single term:  ?or=(title.ilike.*x*,description.ilike.*x*,board_name.ilike.*x*)
    // Multi-term:   ?and=(or(title.ilike.*x*,...),or(title.ilike.*y*,...))
    // This prevents "page" matching every pin just because descriptions say "web page".
    let filterParam: string;
    if (terms.length === 1) {
      const t = terms[0];
      filterParam = `or=(title.ilike.*${t}*,description.ilike.*${t}*,board_name.ilike.*${t}*)`;
    } else {
      const andParts = terms
        .map(t => `or(title.ilike.*${t}*,description.ilike.*${t}*,board_name.ilike.*${t}*)`)
        .join(',');
      filterParam = `and=(${andParts})`;
    }

    const boardFilter = board ? `&board_name=eq.${encodeURIComponent(board)}` : '';
    const url = `${SUPABASE_URL}/rest/v1/pinterest_pins?select=id,pin_id,pin_url,title,board_name,image_url,description,synced_at&${filterParam}${boardFilter}&limit=${limit}&order=synced_at.desc`;

    const response = await fetch(url, { method: 'GET', headers: requestHeaders });
    if (!response.ok) {
      console.error('[Search] Pinterest text search failed:', response.status, await response.text());
      return [];
    }
    return await response.json();
  } catch (err) {
    console.error('[Search] Pinterest text search error:', err);
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
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_bookmarks?select=id,url,title,folder,similarity,created_at`, {
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
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_pinterest_pins?select=id,pin_id,pin_url,title,board_name,image_url,similarity,similarity_raw,description,synced_at`, {
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
 * Optimized with embedding cache and smart vector search skipping
 */
export async function searchSupabase(
  query: string,
  limit = 50,  // Same default as extension
  sourceFilter?: string,
  folder?: string,
  board?: string | null
): Promise<{ results: SearchResult[]; total: number; hasMore: boolean }> {
  const startTime = Date.now();
  console.log(`[Supabase Search] Query: "${query}", limit: ${limit}, source: ${sourceFilter || 'all'}`);

  const isChrome = sourceFilter === 'chrome' || sourceFilter === 'chrome_bookmarks';
  const isPinterest = sourceFilter === 'pinterest';

  // Step 1: Run text search first (fast, doesn't need embedding)
  const textSearchPromise = Promise.all([
    !isPinterest ? searchSupabaseText(query, limit, folder) : Promise.resolve([]),
    !isChrome ? searchSupabasePinsText(query, limit, board) : Promise.resolve([])
  ]);

  // Step 2: Check embedding cache while text search runs
  let cachedEmbedding = getCachedEmbedding(query);
  let embeddingPromise: Promise<number[] | null> | null = null;

  // Only start embedding generation if not cached
  if (!cachedEmbedding) {
    embeddingPromise = generateQueryEmbedding(query).catch(err => {
      console.error('[Supabase Search] Embedding generation failed:', err);
      return null;
    });
  }

  // Wait for text search to complete
  const [bookmarkTextResults, pinTextResults] = await textSearchPromise;
  console.log(`[Supabase Search] Text results - Bookmarks: ${bookmarkTextResults.length}, Pins: ${pinTextResults.length} (${Date.now() - startTime}ms)`);

  // Convert text search results with local keyword scoring (same as extension)
  const textResults: SupabaseSearchResult[] = [
    ...bookmarkTextResults.map(b => {
      const keywordScore = computeLocalKeywordScore(query, b.title, b.folder, b.url);
      const recencyScore = computeRecencyScore(b.created_at);
      return {
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: 0.5,
        keyword_score: keywordScore,
        recency_score: recencyScore,
        combined_score: computeCombinedScore(keywordScore, 0.5, recencyScore, 'chrome'),
        created_at: b.created_at ?? null
      };
    }),
    ...pinTextResults.map(p => {
      const keywordScore = computeLocalKeywordScore(query, p.title, p.board_name, p.pin_url, p.description);
      const recencyScore = computeRecencyScore(p.synced_at);
      return {
        source: 'pinterest' as const,
        item_id: p.pin_id ?? p.id ?? '',
        url: p.pin_url,
        title: p.title || 'Untitled',
        folder_or_board: p.board_name || null,
        image_url: p.image_url || null,
        similarity: 0.5,
        keyword_score: keywordScore,
        recency_score: recencyScore,
        combined_score: computeCombinedScore(keywordScore, 0.5, recencyScore, 'pinterest'),
        description: p.description || null,
        created_at: p.synced_at ?? null
      };
    })
  ].filter(r => r.keyword_score > 0); // Only keep actual matches!

  // Check if we have strong enough text results to skip vector search
  const bestKeywordScore = textResults.length > 0
    ? Math.max(...textResults.map(r => r.keyword_score))
    : 0;
  const hasStrongTextResults = bestKeywordScore >= STRONG_KEYWORD_THRESHOLD &&
                                textResults.length >= MIN_TEXT_RESULTS_TO_SKIP_VECTOR;

  // Get embedding (from cache or wait for generation)
  let embedding: number[] | null = cachedEmbedding;

  if (!embedding && embeddingPromise) {
    // If text results are strong, don't wait for embedding - skip vector search
    if (hasStrongTextResults) {
      console.log(`[Supabase Search] Strong text results (score=${bestKeywordScore.toFixed(2)}, count=${textResults.length}), skipping vector search (${Date.now() - startTime}ms)`);
      const results = textResults.slice(0, limit).map(r => toSearchResult(r));
      return { results, total: results.length, hasMore: textResults.length > limit };
    }

    // Wait for embedding with timeout
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MS)
    );

    embedding = await Promise.race([embeddingPromise, timeoutPromise]);

    if (embedding) {
      setCachedEmbedding(query, embedding);
    } else {
      console.log(`[Supabase Search] Embedding timeout or failed, using text results only (${Date.now() - startTime}ms)`);
      // Return text results if we have any, otherwise continue without vector search
      if (textResults.length > 0) {
        const results = textResults.slice(0, limit).map(r => toSearchResult(r));
        return { results, total: results.length, hasMore: textResults.length > limit };
      }
    }
  }

  // If no embedding available, return text results only
  if (!embedding) {
    console.log(`[Supabase Search] No embedding, using text search only (${Date.now() - startTime}ms)`);
    const results = textResults.slice(0, limit).map(r => toSearchResult(r));
    return { results, total: results.length, hasMore: textResults.length > limit };
  }

  // Do vector search
  const [bookmarkVectorResults, pinVectorResults] = await Promise.all([
    !isPinterest ? searchBookmarksVector(embedding, limit, folder) : Promise.resolve([]),
    !isChrome ? searchPinsVector(embedding, limit, board) : Promise.resolve([])
  ]);

  console.log(`[Supabase Search] Vector results - Bookmarks: ${bookmarkVectorResults.length}, Pins: ${pinVectorResults.length} (${Date.now() - startTime}ms)`);

  // Convert vector search results (same as extension)
  const vectorResults: SupabaseSearchResult[] = [
    ...bookmarkVectorResults.map(b => {
      const similarity = b.similarity || 0;
      const recencyScore = computeRecencyScore(b.created_at);
      return {
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity,
        keyword_score: 0,
        recency_score: recencyScore,
        combined_score: computeCombinedScore(0, similarity, recencyScore, 'chrome'),
        created_at: b.created_at ?? null
      };
    }),
    ...pinVectorResults.map(p => {
      const similarity = typeof p.similarity_raw === 'number' ? 1 - p.similarity_raw : (p.similarity || 0);
      const recencyScore = computeRecencyScore(p.synced_at);
      return {
        source: 'pinterest' as const,
        item_id: p.pin_id ?? p.id ?? '',
        url: p.pin_url,
        title: p.title || 'Untitled',
        folder_or_board: p.board_name || null,
        image_url: p.image_url || null,
        similarity,
        similarity_raw: p.similarity_raw,
        keyword_score: 0,
        recency_score: recencyScore,
        combined_score: computeCombinedScore(0, similarity, recencyScore, 'pinterest'),
        description: p.description || null,
        created_at: p.synced_at ?? null
      };
    })
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
        // Recalculate combined score with the better semantic score
        existing.combined_score = computeCombinedScore(
          existing.keyword_score,
          result.similarity,
          existing.recency_score,
          existing.source
        );
      }
    }
  }

  // Sort: bookmarks FIRST, then by keyword score, then combined score (same as extension)
  mergedResults.sort((a, b) => {
    // Primary: bookmarks ALWAYS come first
    if (a.source === 'chrome' && b.source !== 'chrome') return -1;
    if (b.source === 'chrome' && a.source !== 'chrome') return 1;

    // Within same source: sort by keyword score
    const keywordDiff = (b.keyword_score || 0) - (a.keyword_score || 0);
    if (Math.abs(keywordDiff) > 0.05) return keywordDiff;

    // Then by combined score
    return (b.combined_score || 0) - (a.combined_score || 0);
  });

  const finalResults = mergedResults.slice(0, limit).map(r => toSearchResult(r));

  console.log(`[Supabase Search] Final results: ${finalResults.length} (total time: ${Date.now() - startTime}ms)`);

  return {
    results: finalResults,
    total: finalResults.length,
    hasMore: mergedResults.length > limit
  };
}

/**
 * Get unique folders from Supabase bookmarks
 */
export async function getSupabaseFolders(): Promise<string[]> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/bookmarks?select=folder&order=folder.asc`,
      {
        method: 'GET',
        headers: requestHeaders,
      }
    );

    if (!response.ok) {
      console.error('[Supabase] Failed to fetch folders:', response.status);
      return [];
    }

    const data = await response.json();
    const folders = new Set<string>();
    data.forEach((item: { folder: string | null }) => {
      if (item.folder) folders.add(item.folder);
    });

    return Array.from(folders).sort();
  } catch (error) {
    console.error('[Supabase] Error fetching folders:', error);
    return [];
  }
}

/**
 * Get unique boards from Supabase Pinterest pins
 */
export async function getSupabaseBoards(): Promise<string[]> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/pinterest_pins?select=board_name&order=board_name.asc`,
      {
        method: 'GET',
        headers: requestHeaders,
      }
    );

    if (!response.ok) {
      console.error('[Supabase] Failed to fetch boards:', response.status);
      return [];
    }

    const data = await response.json();
    const boards = new Set<string>();
    data.forEach((item: { board_name: string | null }) => {
      if (item.board_name) boards.add(item.board_name);
    });

    return Array.from(boards).sort();
  } catch (error) {
    console.error('[Supabase] Error fetching boards:', error);
    return [];
  }
}

/**
 * Browse items by folder (bookmarks) or board (pinterest) without search scoring
 */
export async function browseSupabase(
  source: 'chrome' | 'pinterest',
  folderOrBoard: string,
): Promise<{ results: SearchResult[]; total: number }> {
  const PAGE_SIZE = 1000;
  try {
    if (source === 'chrome') {
      const all: Array<{ id: string; url: string; title: string; folder: string | null; created_at: string | null }> = [];
      let offset = 0;
      while (true) {
        // Empty folderOrBoard → fetch all bookmarks (no folder filter)
        const folderFilter = folderOrBoard
          ? `&folder=eq.${encodeURIComponent(folderOrBoard)}`
          : '';
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/bookmarks?select=id,url,title,folder,created_at${folderFilter}&limit=${PAGE_SIZE}&offset=${offset}&order=created_at.desc`,
          { method: 'GET', headers: requestHeaders }
        );
        if (!response.ok) break;
        const page = await response.json();
        all.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      const results: SearchResult[] = all.map(b => ({
        title: b.title,
        url: b.url,
        folder: b.folder,
        source: 'chrome',
        score: 1,
        imageUrl: null,
      }));
      return { results, total: results.length };
    } else {
      // Empty folderOrBoard → fetch all pins (no board filter), same as Chrome bookmarks handling
      const boardFilter = folderOrBoard
        ? `&board_name=eq.${encodeURIComponent(folderOrBoard)}`
        : '';
      const all: Array<{ pin_id?: string; id?: string; pin_url: string; title: string | null; board_name: string | null; image_url: string | null; synced_at?: string | null }> = [];
      let offset = 0;
      while (true) {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/pinterest_pins?select=id,pin_id,pin_url,title,board_name,image_url,synced_at${boardFilter}&limit=${PAGE_SIZE}&offset=${offset}&order=synced_at.desc`,
          { method: 'GET', headers: requestHeaders }
        );
        if (!response.ok) break;
        const page = await response.json();
        all.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      const results: SearchResult[] = all.map(p => ({
        title: p.title || 'Untitled',
        url: p.pin_url,
        folder: p.board_name,
        source: 'pinterest',
        score: 1,
        imageUrl: p.image_url || null,
      }));
      return { results, total: results.length };
    }
  } catch (err) {
    console.error('[Browse] Error:', err);
    return { results: [], total: 0 };
  }
}

/**
 * Convert internal result to API response format
 */
function toSearchResult(r: SupabaseSearchResult): SearchResult {
  // Use pre-computed combined score (matches extension formula)
  const score = r.combined_score;

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
