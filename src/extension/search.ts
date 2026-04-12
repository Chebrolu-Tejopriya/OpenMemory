/**
 * OpenMemory - Hybrid Search with MiniSearch + Supabase AI
 * Full-text search with field weighting and snippet generation
 * Includes Pinterest pins integration and Supabase semantic search
 */

import MiniSearch from 'minisearch';
import { db, IndexedBookmark, PinterestPin } from './db';

// ============== SUPABASE SEARCH ==============
const DEBUG_SEARCH = false;
const DEBUG_VECTOR_ONLY = false;

interface SupabaseBookmark {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  chrome_id: string | null;
  similarity: number;
  created_at?: string | null;
}

interface SupabaseSearchResult {
  source: 'chrome' | 'pinterest';
  item_id: string;
  url: string;
  title: string;
  folder_or_board: string | null;
  image_url: string | null;
  similarity: number;
  description?: string | null;
  similarity_raw?: number;
  keyword_score?: number;  // 1.0 for text/keyword matches, 0 for vector-only matches
  recency_score?: number;
  final_score?: number;
  created_at?: string | null;
}

async function getSupabaseConfig(): Promise<{ url: string; anonKey: string } | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], (result) => {
      if (result.supabaseUrl && result.supabaseAnonKey) {
        resolve({ url: result.supabaseUrl, anonKey: result.supabaseAnonKey });
      } else {
        resolve(null);
      }
    });
  });
}

// Generate embedding via Supabase Edge Function (uses HF with token)
async function generateLocalEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch('http://localhost:3000/embed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      console.error('[Search] Embedding API error:', response.status);
      return null;
    }

    const result = await response.json();
    const embedding = Array.isArray(result.embedding) ? result.embedding : null;
    if (!embedding || embedding.length !== 384) {
      console.error('[Search] Invalid embedding length:', embedding ? embedding.length : 'null');
      return null;
    }
    return embedding;
  } catch (error) {
    console.error('[Search] Embedding failed:', error);
    return null;
  }
}

// Search using vector similarity (semantic search) - includes both bookmarks AND Pinterest pins
async function searchSupabaseVector(
  query: string,
  limit = 50,
  folder?: string,
  source?: 'chrome' | 'pinterest' | 'all',
  board?: string | null
): Promise<SupabaseSearchResult[]> {
  console.log('!!! searchSupabaseVector CALLED !!!', query, Date.now());
  const config = await getSupabaseConfig();
  if (!config) return [];

  const requestHeaders = {
    'apikey': config.anonKey,
    'Authorization': `Bearer ${config.anonKey}`,
    'Content-Type': 'application/json'
  };

  console.log('[Search] === searchSupabaseVector START ===', { query, queryLength: query.length, limit });
  try {
    // ALWAYS do BOTH text search AND vector search in parallel
    // Text search finds exact keyword matches, vector search finds semantic matches
    const embeddingPromise = generateLocalEmbedding(query);
    const textSearchPromise = Promise.all([
      searchSupabaseText(query, limit, folder),
      searchSupabasePinsText(query, limit, board || null)
    ]);

    const [embedding, [bookmarkTextResults, pinTextResults]] = await Promise.all([
      embeddingPromise,
      textSearchPromise
    ]);

    console.log('[Search] Promise.all completed:', {
      hasEmbedding: !!embedding,
      bookmarkTextCount: bookmarkTextResults?.length ?? 'undefined',
      pinTextCount: pinTextResults?.length ?? 'undefined'
    });

    // Convert text search results - ALWAYS compute keyword score locally
    // Don't trust SQL filtering - compute based on actual text matching
    const queryLower = query.toLowerCase().trim();
    console.log('[Search] Query for keyword matching:', JSON.stringify(queryLower), 'length:', queryLower.length);

    // Helper to compute keyword score based on actual text matching
    const computeLocalKeywordScore = (title: string | null, folder: string | null, url: string | null): number => {
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
    };

    const textResults: SupabaseSearchResult[] = [
      ...bookmarkTextResults.map(b => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: 0.5, // Base vector similarity for text matches
        keyword_score: computeLocalKeywordScore(b.title, b.folder, b.url), // Compute locally!
        created_at: b.created_at ?? null
      })),
      ...pinTextResults.map(p => ({
        source: 'pinterest' as const,
        item_id: p.pin_id ?? p.id,
        url: p.pin_url,
        title: p.title || 'Untitled',
        folder_or_board: p.board_name || null,
        image_url: p.image_url || null,
        similarity: 0.5,
        keyword_score: computeLocalKeywordScore(p.title, p.board_name, p.pin_url), // Compute locally!
        description: p.description || null,
        created_at: p.synced_at ?? null
      }))
    ].filter(r => r.keyword_score > 0); // Only keep actual matches!

    if (DEBUG_SEARCH) {
      console.log('[Search] === TEXT SEARCH RESULTS ===');
      console.log('[Search] Raw bookmark results from SQL:', bookmarkTextResults.length);
      console.log('[Search] First 5 raw results:', bookmarkTextResults.slice(0, 5).map((b: any) => ({
        title: b.title,
        url: b.url?.substring(0, 40),
        similarity_from_sql: b.similarity
      })));
      console.log('[Search] Text search results (mapped):', textResults.length);
      console.log('[Search] Text matches:', textResults.slice(0, 10).map(r => ({
        url: r.url?.substring(0, 50),
        title: r.title,
        keyword_score: r.keyword_score
      })));
    }

    // If no embedding, return text results only
    if (!embedding) {
      console.log('[Search] No embedding, using text search only');
      return textResults.slice(0, limit);
    }

    // Do vector search
    // Format embedding as array string for PostgreSQL vector type
    const embeddingStr = `[${embedding.join(',')}]`;

    const [bookmarkResponse, pinResponse] = await Promise.all([
      fetch(`${config.url}/rest/v1/rpc/search_bookmarks`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          query_embedding: embeddingStr,
          match_count: limit,
          filter_folder: folder || null
        })
      }),
      fetch(`${config.url}/rest/v1/rpc/search_pinterest_pins`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          query_embedding: embeddingStr,
          match_count: limit,
          filter_board: board || null
        })
      })
    ]);

    if (!bookmarkResponse.ok) {
      const errorText = await bookmarkResponse.text();
      console.error('[Search] Vector search_bookmarks failed:', bookmarkResponse.status, errorText);
    }
    if (!pinResponse.ok) {
      const errorText = await pinResponse.text();
      console.error('[Search] Vector search_pinterest_pins failed:', pinResponse.status, errorText);
    }

    const bookmarkResults = bookmarkResponse.ok ? await bookmarkResponse.json() : [];
    const pinResults = pinResponse.ok ? await pinResponse.json() : [];

    // Convert vector search results - these are SEMANTIC matches (lower priority)
    const vectorResults: SupabaseSearchResult[] = [
      ...(Array.isArray(bookmarkResults) ? bookmarkResults : []).map((b: SupabaseBookmark & { created_at?: string | null }) => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: b.similarity,
        keyword_score: 0, // Will be computed later based on actual keyword match
        created_at: b.created_at ?? null
      })),
      ...(Array.isArray(pinResults) ? pinResults : []).map((p: any) => ({
        source: 'pinterest' as const,
        item_id: p.pin_id ?? p.id,
        url: p.pin_url,
        title: p.title || 'Untitled',
        folder_or_board: p.board_name || null,
        image_url: p.image_url || null,
        similarity: typeof p.similarity_raw === 'number' ? 1 - p.similarity_raw : p.similarity,
        similarity_raw: p.similarity_raw,
        keyword_score: 0,
        description: p.description || null,
        created_at: p.synced_at ?? null
      }))
    ];

    if (DEBUG_SEARCH) {
      console.log('[Search] Vector search results:', vectorResults.length);
    }

    // Merge results: text matches first, then vector matches (dedupe by URL)
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

    // Sort: keyword matches first, then by similarity
    mergedResults.sort((a, b) => {
      const keywordDiff = (b.keyword_score || 0) - (a.keyword_score || 0);
      if (keywordDiff !== 0) return keywordDiff;
      return (b.similarity || 0) - (a.similarity || 0);
    });

    if (DEBUG_SEARCH) {
      console.log('[Search] Merged results:', mergedResults.length);
      console.log('[Search] Top 5:', mergedResults.slice(0, 5).map(r => ({
        title: r.title,
        keyword: r.keyword_score,
        similarity: r.similarity
      })));
    }

    return mergedResults.slice(0, limit);
  } catch (error) {
    console.error('[Search] Search error:', error);
    // Fallback to text search only
    const [bookmarkResults, pinResults] = await Promise.all([
      searchSupabaseText(query, limit, folder),
      searchSupabasePinsText(query, limit, board || null)
    ]);
    return [
      ...bookmarkResults.map(b => ({
        source: 'chrome' as const,
        item_id: b.id,
        url: b.url,
        title: b.title,
        folder_or_board: b.folder,
        image_url: null,
        similarity: b.similarity,
        keyword_score: 1.0
      })),
      ...pinResults.map(p => ({
        source: 'pinterest' as const,
        item_id: p.pin_id,
        url: p.pin_url,
        title: p.title || 'Pinterest Pin',
        folder_or_board: p.board_name || null,
        image_url: p.image_url || null,
        similarity: p.similarity,
        keyword_score: 1.0,
        description: p.description || null,
        created_at: p.synced_at ?? null
      }))
    ].slice(0, limit);
  }
}

// Fallback text search
async function searchSupabaseText(query: string, limit = 50, folder?: string): Promise<SupabaseBookmark[]> {
  console.log('[Search] searchSupabaseText called with query:', JSON.stringify(query), 'length:', query?.length);
  const config = await getSupabaseConfig();
  if (!config) {
    console.log('[Search] No config, returning empty');
    return [];
  }

  // Don't search with empty query
  if (!query || query.trim().length === 0) {
    console.log('[Search] Empty query, skipping text search');
    return [];
  }

  try {
    const requestBody = {
      p_search_query: query.trim(),
      p_match_count: limit,
      p_filter_folder: folder || null
    };
    console.log('[Search] Calling search_bookmarks_text with:', JSON.stringify(requestBody));

    const response = await fetch(`${config.url}/rest/v1/rpc/search_bookmarks_text`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Search] Text search failed:', response.status, errorText);
      return [];
    }
    const rawResults = await response.json();
    console.log('[Search] Bookmark text search raw results:', rawResults.length);

    // CLIENT-SIDE FILTER: Only keep results that actually contain the query
    // This is a safety net in case the SQL function isn't filtering correctly
    const queryLower = query.trim().toLowerCase();
    const filteredResults = rawResults.filter((r: any) => {
      const titleMatch = (r.title || '').toLowerCase().includes(queryLower);
      const urlMatch = (r.url || '').toLowerCase().includes(queryLower);
      const folderMatch = (r.folder || '').toLowerCase().includes(queryLower);
      return titleMatch || urlMatch || folderMatch;
    });

    // Assign proper similarity scores based on match type
    const scoredResults = filteredResults.map((r: any) => {
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
    scoredResults.sort((a: any, b: any) => b.similarity - a.similarity);

    console.log('[Search] Bookmark text search filtered results:', scoredResults.length);
    if (scoredResults.length > 0) {
      console.log('[Search] First 3 filtered results:', scoredResults.slice(0, 3).map((r: any) => ({
        title: r.title,
        url: r.url?.substring(0, 40),
        similarity: r.similarity
      })));
    }
    return scoredResults;
  } catch (err) {
    console.error('[Search] Text search exception:', err);
    return [];
  }
}

// Main search function - uses vector search with text fallback
async function searchSupabase(
  query: string,
  limit = 50,
  folder?: string,
  source?: 'chrome' | 'pinterest' | 'all',
  board?: string | null
): Promise<SupabaseSearchResult[]> {
  return searchSupabaseVector(query, limit, folder, source, board);
}

async function searchSupabasePinsText(
  query: string,
  limit = 50,
  board?: string | null
): Promise<any[]> {
  const config = await getSupabaseConfig();
  if (!config) return [];

  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/search_pinterest_pins_text`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
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

// ============== HYBRID SEARCH ==============
interface HybridResult {
  url: string;
  title: string;
  folder: string | null;
  textScore: number;     // Keyword match score (0-1)
  semanticScore: number; // Score from vector search (0-1)
  similarityRaw?: number | null;
  recencyScore: number;  // Recency score (0-1)
  combinedScore: number; // Weighted combination
  source: 'chrome' | 'pinterest';
  item?: SearchableItem;
  imageUrl?: string | null;
  createdAt?: number | null;
  searchableText?: string;
}

type SourceFilter = 'all' | 'pinterest' | 'bookmarks';
type TimeFilter = 'all' | 'recent' | 'older';

interface SearchFilters {
  source: SourceFilter;
  board: string | null;
  time: TimeFilter;
  folder: string | null;
}

const RELEVANCE_RATIO = 0.2;
const MIN_RELEVANCE_SCORE = 0.05;
const MIN_SOURCE_RESULTS = 20;
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with']);
const RECENT_DAYS = 30;
const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

function getSearchPoolLimit(): number {
  return Math.max(allItems.length, 1);
}

function buildSearchableText(input: Array<string | null | undefined>): string {
  return input
    .filter(Boolean)
    .map(text => String(text))
    .join(' ')
    .toLowerCase();
}

function normalizeTextForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRequiredTerms(terms: string[]): string[] {
  return terms.filter(term => term.length > 2 && !STOPWORDS.has(term));
}

function normalizeTerm(term: string): string {
  if (term.endsWith('s') && term.length > 3) {
    return term.slice(0, -1);
  }
  return term;
}

function extractQuotedPhrases(query: string): string[] {
  const phrases: string[] = [];
  const regex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) phrases.push(match[1]);
  }
  return phrases;
}

function matchesQueryRequirements(
  text: string,
  terms: string[],
  normalizedQuery: string,
  options: { requirePhrase: boolean; requireAllTerms: boolean }
): boolean {
  const requiredTerms = getRequiredTerms(terms).map(normalizeTerm);
  if (requiredTerms.length === 0) return true;

  const normalizedText = normalizeTextForMatch(text);
  const quotedPhrases = extractQuotedPhrases(normalizedQuery).map(normalizeTextForMatch);
  const requiresLandingPage = normalizeTextForMatch(normalizedQuery).includes('landing page');

  if (options.requirePhrase && requiresLandingPage && !normalizedText.includes('landing page')) {
    return false;
  }

  for (const phrase of quotedPhrases) {
    if (phrase && !normalizedText.includes(phrase)) return false;
  }

  if (options.requireAllTerms) {
    for (const term of requiredTerms) {
      if (!normalizedText.includes(term)) return false;
    }
    return true;
  }

  const minHits = Math.max(1, Math.ceil(requiredTerms.length * 0.6));
  let hits = 0;
  for (const term of requiredTerms) {
    if (normalizedText.includes(term)) hits += 1;
  }
  return hits >= minHits;
}

function filterRelevantResults(results: HybridResult[], terms: string[], normalizedQuery: string): HybridResult[] {
  if (results.length === 0) return results;

  const requireKeywordMatch = terms.length >= 2;
  const strictOptions = { requirePhrase: true, requireAllTerms: true };
  const relaxedBookmarkOptions = { requirePhrase: false, requireAllTerms: false };
  const relaxedPinterestOptions = { requirePhrase: false, requireAllTerms: false };
  const semanticFloorBySource: Record<HybridResult['source'], number> = {
    chrome: 0.5,
    pinterest: 0.45
  };

  const bySource: Record<HybridResult['source'], HybridResult[]> = {
    chrome: [],
    pinterest: []
  };

  results.forEach(result => {
    bySource[result.source].push(result);
  });

  const buildSourceResults = (source: HybridResult['source']): HybridResult[] => {
    const sourceResults = bySource[source];
    const strictMatches = sourceResults.filter(result => {
      const searchableText = result.searchableText || '';
      return matchesQueryRequirements(searchableText, terms, normalizedQuery, strictOptions);
    });

    let combined = strictMatches;
    if (combined.length < MIN_SOURCE_RESULTS) {
      const relaxedOptions = source === 'chrome'
        ? relaxedBookmarkOptions
        : relaxedPinterestOptions;
      const relaxedMatches = sourceResults.filter(result => {
        const searchableText = result.searchableText || '';
        const matchesQuery = matchesQueryRequirements(searchableText, terms, normalizedQuery, relaxedOptions);
        if (!matchesQuery) {
          if (result.semanticScore < semanticFloorBySource[source]) return false;
        }
        return true;
      });

      const seen = new Set(combined.map(item => item.url));
      const appended = relaxedMatches.filter(item => !seen.has(item.url));
      combined = [...combined, ...appended];
    }

    const sourceMax = combined.reduce((max, item) => Math.max(max, item.combinedScore), 0);
    const threshold = Math.max(sourceMax * RELEVANCE_RATIO, MIN_RELEVANCE_SCORE);

    return combined.filter(result => {
      if (result.combinedScore < threshold) return false;

      if (requireKeywordMatch && result.textScore <= 0 && result.semanticScore < semanticFloorBySource[source]) {
        return false;
      }

      if (!result.item) {
        const hasStrongSemantic = result.semanticScore >= 0.2;
        const hasKeywordMatch = result.textScore > 0;
        return hasKeywordMatch || hasStrongSemantic;
      }

      return true;
    });
  };

  const filteredBySource = {
    chrome: buildSourceResults('chrome'),
    pinterest: buildSourceResults('pinterest')
  };

  return [...filteredBySource.chrome, ...filteredBySource.pinterest];
}

function mixSourcesByScore(results: HybridResult[]): HybridResult[] {
  if (results.length < 2) return results;

  // ALWAYS show bookmarks first, then Pinterest
  // Within each group, sort by keyword score then combined score
  return results.sort((a, b) => {
    // Primary: bookmarks ALWAYS come first
    if (a.source === 'chrome' && b.source !== 'chrome') return -1;
    if (b.source === 'chrome' && a.source !== 'chrome') return 1;

    // Within same source: sort by keyword score
    const keywordDiff = b.textScore - a.textScore;
    if (Math.abs(keywordDiff) > 0.05) return keywordDiff;

    // Then by combined score
    return b.combinedScore - a.combinedScore;
  });
}

async function hybridSearch(query: string, limit = getSearchPoolLimit(), filters?: SearchFilters): Promise<HybridResult[]> {
  const normalizedQuery = normalizeQuery(query);
  const terms = tokenizeQuery(normalizedQuery);
  const resultMap = new Map<string, HybridResult>();

  const useSupabase = isSupabaseAvailable;
  const localResultsPromise = DEBUG_VECTOR_ONLY && useSupabase
    ? Promise.resolve([])
    : Promise.resolve(search(normalizedQuery));
  const supabaseResultsPromise = useSupabase
    ? searchSupabase(
        normalizedQuery,
        limit,
        filters?.folder || undefined,
        filters?.source === 'bookmarks' ? 'chrome' : filters?.source === 'pinterest' ? 'pinterest' : 'all',
        filters?.board || null
      )
    : Promise.resolve([]);

  const [localResults, supabaseResults] = await Promise.all([
    localResultsPromise,
    supabaseResultsPromise
  ]);

  // Add local results to map
  for (const result of localResults) {
    const url = result.item.source === 'chrome' ? result.item.url : result.item.pinUrl;
    const folderOrBoard = result.item.source === 'chrome'
      ? result.item.folder || null
      : result.item.boardName || null;
    const createdAt = getItemTimestamp(result.item);
    const extraText = result.item.source === 'chrome'
      ? result.item.extendedContent || null
      : result.item.description || null;
    const textScore = computeTextMatchScore(result.item.title, folderOrBoard, terms, extraText, url);

    resultMap.set(url, {
      url,
      title: result.item.title,
      folder: folderOrBoard,
      textScore,
      semanticScore: 0,
      recencyScore: 0,
      combinedScore: 0,
      source: result.item.source,
      item: result.item,
      createdAt,
      searchableText: buildSearchableText([
        result.item.title,
        folderOrBoard,
        extraText,
        url,
        result.item.source === 'pinterest' ? 'pinterest' : 'bookmark'
      ])
    });
  }

  // Add/merge Supabase results (now includes both bookmarks AND Pinterest pins)
  if (DEBUG_SEARCH) {
    console.log('[Search] === SUPABASE RESULTS TO MERGE ===');
    console.log('[Search] Total supabase results:', supabaseResults.length);
    const withKeywordScore = supabaseResults.filter(r => r.keyword_score !== undefined && r.keyword_score > 0);
    const withoutKeywordScore = supabaseResults.filter(r => !r.keyword_score || r.keyword_score === 0);
    console.log('[Search] Results with keyword_score > 0:', withKeywordScore.length);
    console.log('[Search] Results needing computeTextMatchScore:', withoutKeywordScore.length);
    console.log('[Search] First 5 with keyword_score:', withKeywordScore.slice(0, 5).map(r => ({
      title: r.title,
      keyword_score: r.keyword_score,
      similarity: r.similarity
    })));
  }
  // Log the query terms being used for keyword matching
  if (DEBUG_SEARCH) {
    console.log('[Search] Hybrid search terms for keyword matching:', terms);
  }

  for (const result of supabaseResults) {
    const existing = resultMap.get(result.url);
    const semanticScore = result.similarity || 0;
    const createdAt = result.created_at ? Date.parse(result.created_at) : null;
    // USE keyword_score from Supabase if it exists (from text search), otherwise compute it
    const hasKeywordScore = result.keyword_score !== undefined && result.keyword_score > 0;
    const computedScore = hasKeywordScore ? result.keyword_score : computeTextMatchScore(result.title, result.folder_or_board, terms, result.description || null, result.url);
    const textScore = computedScore;

    // Debug log for items that should have keyword matches
    if (DEBUG_SEARCH && result.title && result.title.toLowerCase().includes(terms.join(' ').toLowerCase())) {
      console.log('[Search] Keyword match candidate:', {
        title: result.title,
        hasKeywordScore,
        supabaseKeywordScore: result.keyword_score,
        computedTextScore: computedScore,
        terms: terms.join(' ')
      });
    }
    const recencyScore = result.recency_score ?? 0;
    const finalScore = result.final_score ?? 0;
    const similarityRaw = result.similarity_raw ?? null;

    if (existing) {
      existing.semanticScore = Math.max(existing.semanticScore, semanticScore);
      // Keep the HIGHER textScore (keyword matches from text search should win)
      existing.textScore = Math.max(existing.textScore, textScore);
      if (result.final_score !== undefined) {
        existing.combinedScore = Math.max(existing.combinedScore, finalScore);
        existing.recencyScore = Math.max(existing.recencyScore, recencyScore);
        existing.similarityRaw = similarityRaw;
      }
      if (!existing.createdAt && createdAt) {
        existing.createdAt = createdAt;
      }
    } else {
      resultMap.set(result.url, {
        url: result.url,
        title: result.title,
        folder: result.folder_or_board,
        textScore, // Now uses keyword_score from text search if available
        semanticScore: semanticScore,
        similarityRaw: similarityRaw,
        recencyScore: recencyScore,
        combinedScore: finalScore,
        source: result.source, // 'chrome' or 'pinterest'
        item: undefined,
        imageUrl: result.image_url ?? null,
        createdAt,
        searchableText: buildSearchableText([
          result.title,
          result.folder_or_board,
          result.description || null,
          result.url,
          result.source
        ])
      });
    }
  }

  let results = Array.from(resultMap.values());
  if (filters) {
    results = applyFilters(results, filters);
  }

  const resultsNeedingScores = results.filter(result => result.combinedScore <= 0);
  if (resultsNeedingScores.length > 0) {
    applyRecencyScores(resultsNeedingScores);
    resultsNeedingScores.forEach(result => {
      // Source boost: bookmarks get priority
      const sourceBoost = result.source === 'chrome' ? 1.0 : 0.0;
      // Keyword-first scoring: keyword matches are the primary signal
      result.combinedScore =
        (0.55 * result.textScore) +      // Keyword is PRIMARY
        (0.10 * result.semanticScore) +  // Vector is secondary
        (0.15 * result.recencyScore) +
        (0.20 * sourceBoost);
    });
  }

  // Sort by keyword score first, then combined score
  results.sort((a, b) => {
    const keywordDiff = b.textScore - a.textScore;
    if (Math.abs(keywordDiff) > 0.1) return keywordDiff;
    return b.combinedScore - a.combinedScore;
  });

  if (DEBUG_SEARCH) {
    results.forEach(result => {
      console.log('[Search Debug]', {
        title: result.title,
        vector_similarity: result.semanticScore,
        similarity_raw: result.similarityRaw ?? null,
        keyword_score: result.textScore,
        recency_score: result.recencyScore,
        final_score: result.combinedScore
      });
    });

    const topFiveByVector = [...results]
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, 5);
    console.log('[Search Debug] Top 5 vector similarities', topFiveByVector.map(result => ({
      title: result.title,
      similarity_raw: result.similarityRaw ?? null,
      vector_similarity: result.semanticScore
    })));

    const similarityZeroCount = results.filter(result => result.semanticScore === 0).length;
    if (results.length > 0 && similarityZeroCount / results.length > 0.9) {
      console.warn('[Search Debug] Vector similarity is near-zero for most results. Check embedding content and match_count pool.');
    }

    if (results.length > 0 && results.every(result => result.semanticScore === 0)) {
      console.error('[Search Debug] Vector similarity is 0 for all results. Check embedding generation and RPC query usage.');
    }

    if (normalizeQuery(query) === 'fintech') {
      const topFive = [...results]
        .sort((a, b) => b.combinedScore - a.combinedScore)
        .slice(0, 5);
      const fintechRegex = /fintech|finance|bank|banking|payment|payments|card|crypto|wallet|lending|invest|trading|loan|account|fund|billing|invoice/i;
      const invalid = topFive.filter(result => !fintechRegex.test(result.title || '') && !fintechRegex.test(result.folder || ''));
      if (invalid.length > 0) {
        console.warn('[Search Debug] Fintech ranking likely incorrect. Top 5 results missing fintech content.', {
          topTitles: topFive.map(result => result.title)
        });
      }
    }
  }

  const sorted = results
    .sort((a, b) => b.combinedScore - a.combinedScore);
  if (DEBUG_VECTOR_ONLY) {
    return [...sorted].sort((a, b) => b.semanticScore - a.semanticScore);
  }

  return mixSourcesByScore(filterRelevantResults(sorted, terms, normalizedQuery));
}

// ============== INTERFACES ==============
type SearchableItem = (IndexedBookmark & { source: 'chrome' }) | (PinterestPin & { source: 'pinterest' });

interface SearchResult {
  item: SearchableItem;
  score: number;
  matchField: 'title' | 'folder' | 'extendedContent' | 'boardName';
  snippet?: string;
  debugScores?: {
    semantic: number;
    keyword: number;
    recency: number;
    final: number;
  };
}

interface SearchableDocument {
  id: string; // Changed to string to handle composite IDs
  title: string;
  url: string;
  folder: string;
  extendedContent: string;
  contentType: string;
  source: 'chrome' | 'pinterest';
}

// ============== DOM ELEMENTS ==============
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const loadMoreBtn = document.getElementById('load-more-btn') as HTMLButtonElement;
const suggestionsEl = document.getElementById('suggestions') as HTMLDivElement;
const filterChipsEl = document.getElementById('filter-chips') as HTMLDivElement;
const filterAddBtn = document.getElementById('filter-add') as HTMLButtonElement;
const filterMenuEl = document.getElementById('filter-menu') as HTMLDivElement;
const filterBoardSection = document.getElementById('filter-board-section') as HTMLDivElement;
const filterFolderSection = document.getElementById('filter-folder-section') as HTMLDivElement;
const itemCountEl = document.getElementById('item-count') as HTMLSpanElement;

// Integrations UI elements
const integrationsToggle = document.getElementById('integrations-toggle') as HTMLButtonElement;
const integrationsSection = document.getElementById('integrations-section') as HTMLDivElement;
const closeIntegrations = document.getElementById('close-integrations') as HTMLButtonElement;
const pinterestStatus = document.getElementById('pinterest-status') as HTMLDivElement;
const pinterestConnect = document.getElementById('pinterest-connect') as HTMLButtonElement;
const pinterestReset = document.getElementById('pinterest-reset') as HTMLButtonElement;
const pinterestProgress = document.getElementById('pinterest-progress') as HTMLDivElement;
const pinterestProgressFill = document.getElementById('pinterest-progress-fill') as HTMLDivElement;
const pinterestProgressText = document.getElementById('pinterest-progress-text') as HTMLDivElement;
const pinterestSyncStats = document.getElementById('pinterest-sync-stats') as HTMLDivElement;
const pinterestBoardTotal = document.getElementById('pinterest-board-total') as HTMLDivElement;
const pinterestBoardUpdated = document.getElementById('pinterest-board-updated') as HTMLDivElement;
const pinterestBoardArchived = document.getElementById('pinterest-board-archived') as HTMLDivElement;
const pinterestDeepSync = document.getElementById('pinterest-deep-sync') as HTMLInputElement;
if (pinterestDeepSync) {
  pinterestDeepSync.checked = true;
}
const bookmarksStatus = document.getElementById('bookmarks-status') as HTMLDivElement;
const bookmarksSync = document.getElementById('bookmarks-sync') as HTMLButtonElement;

// Board selection elements
const boardSelection = document.getElementById('board-selection') as HTMLDivElement;
const closeBoardSelection = document.getElementById('close-board-selection') as HTMLButtonElement;
const boardCount = document.getElementById('board-count') as HTMLSpanElement;
const boardList = document.getElementById('board-list') as HTMLDivElement;
const selectAllBoards = document.getElementById('select-all-boards') as HTMLButtonElement;
const syncSelectedBoards = document.getElementById('sync-selected-boards') as HTMLButtonElement;

// Pinterest Import elements
const pinterestImportBtn = document.getElementById('pinterest-import-current') as HTMLButtonElement;
const pinterestResyncBtn = document.getElementById('pinterest-resync-current') as HTMLButtonElement;
const pinterestImportProgress = document.getElementById('pinterest-import-progress') as HTMLDivElement;
const pinterestImportProgressFill = document.getElementById('pinterest-import-progress-fill') as HTMLDivElement;
const pinterestImportStatus = document.getElementById('pinterest-import-status') as HTMLDivElement;
const pinterestImportResult = document.getElementById('pinterest-import-result') as HTMLDivElement;
const pinterestBoardsSection = document.getElementById('pinterest-boards-section') as HTMLDivElement;
const pinterestBoardsList = document.getElementById('pinterest-boards-list') as HTMLDivElement;
const pinterestBoardsMessage = document.getElementById('pinterest-boards-message') as HTMLDivElement;

interface DiscoveredBoard {
  name: string;
  url: string;
}

let discoveredBoards: DiscoveredBoard[] = [];
let discoveredUsername: string | null = null;

interface PinterestBoardRow {
  board_name: string | null;
  board_url: string;
  total_pins: number | null;
  imported_pins: number | null;
  last_synced_at: string | null;
}

// ============== STATE ==============
let allItems: SearchableItem[] = [];
let allFolders: string[] = [];
let miniSearch: MiniSearch<SearchableDocument> | null = null;
let currentResults: SearchResult[] = [];
let displayedCount = 0;
let currentFolder: string | null = null;
let selectedSourceFilter: SourceFilter = 'all';
let selectedBoardFilter: string | null = null;
let selectedTimeFilter: TimeFilter = 'all';
let selectedFolderFilter: string | null = null;
let selectedSuggestionIndex = -1;
const ITEMS_PER_PAGE = 20;

// Supabase availability flag
let isSupabaseAvailable = false;

// Object URL cache for Pinterest images
const blobUrlCache = new Map<string, string>();

// ============== INITIALIZATION ==============
async function initializeSearch(): Promise<void> {
  try {
    // Load bookmarks from IndexedDB
    const [bookmarks, pins] = await Promise.all([
      db.bookmarks.toArray(),
      db.pins.toArray()
    ]);

    // Mark sources and combine
    const bookmarkItems: SearchableItem[] = bookmarks.map(b => ({ ...b, source: 'chrome' as const }));
    const pinItems: SearchableItem[] = pins.map(p => ({ ...p, source: 'pinterest' as const }));

    allItems = [...bookmarkItems, ...pinItems];

    // If no bookmarks, try fallback to data.json
    if (bookmarks.length === 0) {
      console.log('[OpenMemory] Loading from data.json...');
      try {
        const response = await fetch(chrome.runtime.getURL('data.json'));
        if (response.ok) {
          const data = await response.json();
          const jsonItems: SearchableItem[] = (data.items || []).map((item: any) => ({
            ...item,
            indexStatus: 'pending' as const,
            source: 'chrome' as const
          }));
          allItems = [...jsonItems, ...pinItems];
          allFolders = data.folders || [];
        }
      } catch (fetchError) {
        console.warn('[OpenMemory] Could not load data.json:', fetchError);
      }
    }

    // Extract unique folders from bookmarks
    if (allFolders.length === 0) {
      const folderSet = new Set<string>();
      allItems.forEach(item => {
        if (item.source === 'chrome' && item.folder) {
          folderSet.add(item.folder);
        }
      });
      allFolders = Array.from(folderSet).sort();
    }

    // Initialize MiniSearch
    initializeMiniSearch();

    updateFilterOptions();

    const pinsCount = pins.length;
    const bookmarksCount = bookmarks.length || allItems.filter(i => i.source === 'chrome').length;
    
    // Update count display
    if (pinsCount > 0 && bookmarksCount > 0) {
      itemCountEl.textContent = `${bookmarksCount} 📚 ${pinsCount} 📌`;
    } else if (pinsCount > 0) {
      itemCountEl.textContent = `${pinsCount} pins`;
    } else {
      itemCountEl.textContent = `${bookmarksCount} items`;
    }

    console.log(`[OpenMemory] Loaded ${bookmarksCount} bookmarks, ${pinsCount} pins`);

    // Auto-trigger indexing silently in background
    const queueCount = await db.queue.count();
    if (queueCount > 0) {
      console.log(`[OpenMemory] Auto-indexing ${queueCount} items in background...`);
      chrome.runtime.sendMessage({ type: 'TRIGGER_INDEXING' });
    }
  } catch (err) {
    console.error('[OpenMemory] Failed to load data:', err);
    itemCountEl.textContent = 'No data';
    statusEl.textContent = 'Error: Could not load bookmark data';
  }
}

function initializeMiniSearch(): void {
  miniSearch = new MiniSearch<SearchableDocument>({
    fields: ['title', 'folder', 'extendedContent'],
    storeFields: ['title', 'url', 'folder', 'extendedContent', 'contentType', 'source'],
    searchOptions: {
      boost: {
        title: 3,
        folder: 1.5,
        extendedContent: 1
      },
      fuzzy: 0.2,
      prefix: true
    },
    idField: 'id'
  });

  const documents: SearchableDocument[] = allItems.map((item, index) => {
    if (item.source === 'pinterest') {
      return {
        id: `pin_${item.pinId}`,
        title: item.title || '',
        url: item.pinUrl || '',
        folder: item.boardName || '', // Use boardName as folder for searching
        extendedContent: item.description || '',
        contentType: 'pinterest',
        source: 'pinterest' as const
      };
    } else {
      return {
        id: `bm_${item.id ?? index}`,
        title: item.title || '',
        url: item.url || '',
        folder: item.folder || '',
        extendedContent: item.extendedContent || '',
        contentType: item.contentType || '',
        source: 'chrome' as const
      };
    }
  });

  miniSearch.addAll(documents);
  console.log('[OpenMemory] MiniSearch index built with', documents.length, 'documents');
}

async function updateIndexingStatus(): Promise<void> {
  // Indexing happens automatically in background - no need to show progress
}

// ============== SEARCH FUNCTION ==============
function search(query: string): SearchResult[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery || !miniSearch) return [];

  // Check for special blog/article queries
  const isBlogQuery = /\b(blog|article|post|journal)\b/i.test(normalizedQuery);
  const isPinterestQuery = /\b(pin|pinterest|board)\b/i.test(normalizedQuery);

  // Perform MiniSearch
  const results = miniSearch.search(normalizedQuery);

  // Map to SearchResult with additional metadata
  let searchResults: SearchResult[] = [];

  for (const result of results) {
    // Find item by composite ID
    const resultId = result.id as string;
    let item: SearchableItem | undefined;

    if (resultId.startsWith('pin_')) {
      const pinId = resultId.substring(4);
      item = allItems.find(i => i.source === 'pinterest' && i.pinId === pinId) as SearchableItem | undefined;
    } else if (resultId.startsWith('bm_')) {
      const bmId = parseInt(resultId.substring(3), 10);
      item = allItems.find((i, idx) => i.source === 'chrome' && (i.id ?? idx) === bmId) as SearchableItem | undefined;
    }

    if (!item) continue;

    const matchField = determineMatchField(normalizedQuery, item);
    let snippet: string | undefined;

    if (item.source === 'chrome' && matchField === 'extendedContent') {
      snippet = generateSnippet(item.extendedContent || '', normalizedQuery);
    } else if (item.source === 'pinterest' && item.description) {
      snippet = generateSnippet(item.description, normalizedQuery);
    }

    searchResults.push({
      item,
      score: result.score,
      matchField,
      snippet
    });
  }

  // Boost blog content for blog queries
  if (isBlogQuery) {
    searchResults = searchResults.map(r => ({
      ...r,
      score: r.item.source === 'chrome' && r.item.contentType === 'blog' ? r.score * 2 : r.score
    }));
    searchResults.sort((a, b) => b.score - a.score);
  }

  // Boost Pinterest content for pinterest queries
  if (isPinterestQuery) {
    searchResults = searchResults.map(r => ({
      ...r,
      score: r.item.source === 'pinterest' ? r.score * 2 : r.score
    }));
    searchResults.sort((a, b) => b.score - a.score);
  }

  // Apply folder filter if set
  if (currentFolder) {
    searchResults = searchResults.filter(r => {
      if (r.item.source === 'chrome') {
        return r.item.folder?.toLowerCase().startsWith(currentFolder!.toLowerCase());
      } else {
        return r.item.boardName?.toLowerCase().startsWith(currentFolder!.toLowerCase());
      }
    });
  }

  return searchResults;
}

function determineMatchField(query: string, item: SearchableItem): 'title' | 'folder' | 'extendedContent' | 'boardName' {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  // Check if any query word matches title
  for (const word of queryWords) {
    if (item.title.toLowerCase().includes(word)) return 'title';
  }

  // Check folder/boardName
  if (item.source === 'chrome') {
    for (const word of queryWords) {
      if (item.folder?.toLowerCase().includes(word)) return 'folder';
    }
  } else {
    for (const word of queryWords) {
      if (item.boardName?.toLowerCase().includes(word)) return 'boardName';
    }
  }

  return 'extendedContent';
}

function generateSnippet(content: string, query: string): string {
  if (!content) return '';

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  const contentLower = content.toLowerCase();

  // Find the first matching word
  let matchIndex = -1;
  for (const word of queryWords) {
    const idx = contentLower.indexOf(word);
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }

  if (matchIndex === -1) {
    return content.substring(0, 120) + (content.length > 120 ? '...' : '');
  }

  // Extract surrounding context
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(content.length, matchIndex + 80);

  let snippet = content.substring(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// ============== RENDERING ==============
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatPath(folder: string): string {
  if (!folder) return '';
  return folder.split('/').map(p => escapeHtml(p)).join('<span>/</span>');
}

function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return '';
  }
}

function getScreenshotUrl(url: string): string {
  return `https://v1.screenshot.11ty.dev/${encodeURIComponent(url)}/opengraph/`;
}

function highlightQuery(text: string, query: string): string {
  if (!query || !text) return text;
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let result = text;
  for (const word of words) {
    const regex = new RegExp(`(${escapeRegExp(word)})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }
  return result;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderCard(result: SearchResult): string {
  const { item, snippet } = result;

  if (item.source === 'pinterest') {
    return renderPinterestCard(item, snippet, result.debugScores);
  }

  return renderBookmarkCard(item, snippet, result.debugScores);
}

function renderBookmarkCard(
  item: IndexedBookmark & { source: 'chrome' },
  snippet?: string,
  debugScores?: SearchResult['debugScores']
): string {
  const faviconUrl = getFaviconUrl(item.url);
  const screenshotUrl = getScreenshotUrl(item.url);

  // Blog badge
  const blogBadge = item.contentType === 'blog'
    ? '<span class="blog-badge">Blog</span>'
    : '';

  // Snippet HTML (only for extendedContent matches)
  const snippetHtml = snippet
    ? `<div class="card-snippet">${highlightQuery(escapeHtml(snippet), searchInput.value)}</div>`
    : '';

  const debugScoreHtml = DEBUG_SEARCH && debugScores
    ? `<div class="card-score">Score: ${debugScores.final.toFixed(3)} (vec ${debugScores.semantic.toFixed(3)}, kw ${debugScores.keyword.toFixed(3)}, rec ${debugScores.recency.toFixed(3)})</div>`
    : '';

  return `
    <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="card">
      <div class="card-thumbnail">
        <div class="placeholder">
          <img class="placeholder-favicon" src="${faviconUrl}" alt="">
        </div>
        <img class="card-screenshot loading" src="${screenshotUrl}" alt="">
      </div>
      <div class="card-content">
        <div class="card-title">
          <span class="card-title-text">${escapeHtml(item.title)}</span>
          ${blogBadge}
        </div>
        ${item.folder ? `<div class="card-path">${formatPath(item.folder)}</div>` : ''}
        ${snippetHtml}
        ${debugScoreHtml}
        <div class="card-meta">
          <span class="source-badge">Chrome</span>
        </div>
      </div>
    </a>
  `;
}

function renderPinterestCard(
  item: PinterestPin & { source: 'pinterest' },
  snippet?: string,
  debugScores?: SearchResult['debugScores']
): string {
  // Use stored WebP blob or original URL
  let imageUrl = item.originalImageUrl;

  if (item.imageBlob) {
    // Check cache first
    const cacheKey = item.pinId;
    if (blobUrlCache.has(cacheKey)) {
      imageUrl = blobUrlCache.get(cacheKey)!;
    } else {
      const blobUrl = URL.createObjectURL(item.imageBlob);
      blobUrlCache.set(cacheKey, blobUrl);
      imageUrl = blobUrl;
    }
  }

  const snippetHtml = snippet
    ? `<div class="card-snippet">${highlightQuery(escapeHtml(snippet), searchInput.value)}</div>`
    : '';

  const debugScoreHtml = DEBUG_SEARCH && debugScores
    ? `<div class="card-score">Score: ${debugScores.final.toFixed(3)} (vec ${debugScores.semantic.toFixed(3)}, kw ${debugScores.keyword.toFixed(3)}, rec ${debugScores.recency.toFixed(3)})</div>`
    : '';

  const titleText = item.title || 'Pinterest Pin';

  return `
    <a href="${escapeHtml(item.pinUrl)}" target="_blank" rel="noopener" class="card pinterest">
      <div class="card-thumbnail">
        <div class="placeholder">
          <div class="pinterest-placeholder-icon">P</div>
        </div>
        <img class="card-screenshot loading" src="${escapeHtml(imageUrl)}" alt="">
        <div class="pinterest-icon">
          <svg viewBox="0 0 24 24" width="12" height="12">
            <path fill="#ffffff" d="M12 0C5.4 0 0 5.4 0 12c0 5.1 3.2 9.4 7.6 11.2-.1-.9-.2-2.4 0-3.4.2-.9 1.4-6 1.4-6s-.4-.7-.4-1.8c0-1.7 1-2.9 2.2-2.9 1 0 1.5.8 1.5 1.7 0 1-.7 2.6-1 4-.3 1.2.6 2.2 1.8 2.2 2.1 0 3.8-2.2 3.8-5.5 0-2.9-2.1-4.9-5-4.9-3.4 0-5.4 2.6-5.4 5.2 0 1 .4 2.1.9 2.7.1.1.1.2.1.3-.1.4-.3 1.2-.3 1.4-.1.2-.2.3-.4.2-1.5-.7-2.4-2.9-2.4-4.6 0-3.8 2.8-7.3 8-7.3 4.2 0 7.5 3 7.5 7 0 4.2-2.6 7.5-6.3 7.5-1.2 0-2.4-.6-2.8-1.4l-.8 3c-.3 1.1-.9 2.2-1.4 3 1 .3 2.1.5 3.3.5 6.6 0 12-5.4 12-12S18.6 0 12 0z"/>
          </svg>
        </div>
      </div>
      <div class="card-content">
        <div class="card-title">
          <span class="card-title-text">${escapeHtml(titleText)}</span>
        </div>
        <div class="card-path">Pinterest<span>/</span>${escapeHtml(item.boardName)}</div>
        ${snippetHtml}
        ${debugScoreHtml}
        <div class="card-meta">
          <span class="source-badge pinterest">Pinterest</span>
        </div>
      </div>
    </a>
  `;
}

function renderResults(results: SearchResult[], append = false): void {
  if (results.length === 0 && !append) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <h2>No inspirations found</h2>
        <p>Try a different search term</p>
      </div>
    `;
    loadMoreBtn.style.display = 'none';
    return;
  }

  const html = results.map(renderCard).join('');
  if (append) {
    resultsEl.insertAdjacentHTML('beforeend', html);
  } else {
    resultsEl.innerHTML = html;
  }
}

// ============== FOLDER SUGGESTIONS ==============
function showSuggestions(filter: string): void {
  const filtered = allFolders
    .filter(f => f.toLowerCase().includes(filter.toLowerCase()));

  if (filtered.length === 0) {
    hideSuggestions();
    return;
  }

  selectedSuggestionIndex = -1;
  suggestionsEl.innerHTML = filtered.map((folder, i) => `
    <div class="suggestion-item" data-folder="${escapeHtml(folder)}" data-index="${i}">
      📁 ${escapeHtml(folder)}
    </div>
  `).join('');
  suggestionsEl.classList.add('active');
}

function hideSuggestions(): void {
  suggestionsEl.classList.remove('active');
  selectedSuggestionIndex = -1;
}

function selectFolder(folder: string): void {
  currentFolder = folder;
  selectedFolderFilter = folder;
  selectedSourceFilter = 'bookmarks';
  renderFilterChips();

  const value = searchInput.value;
  const atIndex = value.lastIndexOf('@');
  if (atIndex !== -1) {
    searchInput.value = value.substring(0, atIndex).trim();
  }

  hideSuggestions();
  searchInput.focus();

  if (searchInput.value.trim()) {
    performSearch();
  }
}

function clearFilter(): void {
  currentFolder = null;
  selectedFolderFilter = null;
  renderFilterChips();
  if (searchInput.value.trim()) {
    performSearch();
  }
}

// ============== SEARCH MODE UI ==============
function updateSearchModeUI(): void {
  // Hide the toggle button - we use unified smart search now
  const toggleBtn = document.getElementById('search-mode-toggle');
  if (toggleBtn) {
    toggleBtn.style.display = 'none';
  }
}

// ============== SEARCH EXECUTION ==============
let isSearching = false;

async function performSearch(): Promise<void> {
  applyFilterFromControls();
  const query = normalizeQuery(searchInput.value);
  if (!query) {
    resultsEl.innerHTML = '';
    statusEl.textContent = '';
    loadMoreBtn.style.display = 'none';
    return;
  }

  // Require minimum 2 characters for meaningful search
  if (query.length < 2) {
    resultsEl.innerHTML = '';
    statusEl.textContent = 'Type at least 2 characters to search';
    loadMoreBtn.style.display = 'none';
    return;
  }

  // Prevent concurrent searches
  if (isSearching) return;
  isSearching = true;

  const filterInfoParts: string[] = [];
  if (selectedSourceFilter !== 'all') {
    filterInfoParts.push(selectedSourceFilter === 'bookmarks' ? 'Bookmarks' : 'Pinterest');
  }
  if (selectedBoardFilter) {
    filterInfoParts.push(`Board: ${selectedBoardFilter}`);
  }
  if (selectedTimeFilter !== 'all') {
    filterInfoParts.push(selectedTimeFilter === 'recent' ? 'Recent' : 'Older');
  }
  if (selectedFolderFilter || currentFolder) {
    filterInfoParts.push(`Folder: ${selectedFolderFilter || currentFolder}`);
  }
  const filterInfo = filterInfoParts.length > 0 ? ` (${filterInfoParts.join(', ')})` : '';

  try {
    if (isSupabaseAvailable) {
      // Smart Search: Keywords + AI combined (like Google)
      statusEl.textContent = `Searching...`;

      const hybridResults = await hybridSearch(query, getSearchPoolLimit(), {
        source: selectedSourceFilter,
        board: selectedBoardFilter,
        time: selectedTimeFilter,
        folder: selectedFolderFilter || currentFolder
      });

      // Convert hybrid results to SearchResult format
      currentResults = hybridResults.map(r => {
        const baseItem = r.item || (r.source === 'pinterest'
          ? ({
              pinId: r.url,
              boardName: r.folder || 'Pinterest',
              boardUrl: '',
              title: r.title,
              description: undefined,
              pinUrl: r.url,
              sourceUrl: undefined,
              imageBlob: undefined,
              originalImageUrl: r.imageUrl || '',
              syncedAt: r.createdAt || Date.now(),
              source: 'pinterest' as const
            } as PinterestPin & { source: 'pinterest' })
          : ({
              id: undefined,
              url: r.url,
              title: r.title,
              folder: r.folder,
              indexStatus: 'indexed' as const,
              source: 'chrome' as const
            } as IndexedBookmark & { source: 'chrome' }));
        return {
          item: baseItem,
          score: r.combinedScore,
          matchField: r.textScore > 0 ? 'title' as const : 'extendedContent' as const,
          snippet: undefined,
          debugScores: DEBUG_SEARCH ? {
            semantic: r.semanticScore,
            keyword: r.textScore,
            recency: r.recencyScore,
            final: r.combinedScore
          } : undefined
        };
      });

      statusEl.textContent = `${currentResults.length} results found${filterInfo}`;

    } else {
      // Local MiniSearch only (Supabase not configured)
      currentResults = search(query);
      const normalizedQuery = normalizeQuery(query);
      const terms = tokenizeQuery(normalizedQuery);
      const localHybrid = currentResults.map(r => {
        const itemUrl = r.item.source === 'chrome' ? r.item.url : r.item.pinUrl;
        return {
        url: itemUrl,
        title: r.item.title,
        folder: r.item.source === 'chrome' ? r.item.folder || null : r.item.boardName || null,
        textScore: computeTextMatchScore(
          r.item.title,
          r.item.source === 'chrome' ? r.item.folder : r.item.boardName,
          terms,
          r.item.source === 'chrome' ? r.item.extendedContent || null : r.item.description || null,
          itemUrl
        ),
        semanticScore: 0,
        recencyScore: 0,
        combinedScore: 0,
        source: r.item.source,
        item: r.item,
        createdAt: getItemTimestamp(r.item),
        searchableText: buildSearchableText([
          r.item.title,
          r.item.source === 'chrome' ? r.item.folder || null : r.item.boardName || null,
          r.item.source === 'chrome' ? r.item.extendedContent || null : r.item.description || null,
          itemUrl,
          r.item.source === 'pinterest' ? 'pinterest' : 'bookmark'
        ])
      };
      });

      const filtered = applyFilters(localHybrid, {
        source: selectedSourceFilter,
        board: selectedBoardFilter,
        time: selectedTimeFilter,
        folder: selectedFolderFilter || currentFolder
      });
      applyRecencyScores(filtered);
      filtered.forEach(result => {
        // Source boost: bookmarks get priority
        const sourceBoost = result.source === 'chrome' ? 1.0 : 0.0;
        // Keyword-first scoring: keyword matches are the primary signal
        result.combinedScore =
          (0.55 * result.textScore) +      // Keyword is PRIMARY
          (0.10 * result.semanticScore) +  // Vector is secondary
          (0.15 * result.recencyScore) +
          (0.20 * sourceBoost);
      });
      const reranked = filtered
        .sort((a, b) => {
          // First sort by keyword score, then by combined score
          const keywordDiff = b.textScore - a.textScore;
          if (Math.abs(keywordDiff) > 0.1) return keywordDiff;
          return b.combinedScore - a.combinedScore;
        });

      currentResults = mixSourcesByScore(filterRelevantResults(reranked, terms, normalizedQuery)).map(r => ({
        item: r.item!,
        score: r.combinedScore,
        matchField: r.textScore > 0 ? 'title' as const : 'extendedContent' as const,
        snippet: undefined,
        debugScores: DEBUG_SEARCH ? {
          semantic: r.semanticScore,
          keyword: r.textScore,
          recency: r.recencyScore,
          final: r.combinedScore
        } : undefined
      }));
      statusEl.textContent = `${currentResults.length} results found${filterInfo}`;
    }
  } catch (error) {
    console.error('[OpenMemory] Search failed:', error);
    // Fallback to local search on error
    currentResults = search(query);
    statusEl.textContent = `${currentResults.length} results found${filterInfo}`;
  }

  displayedCount = 0;
  isSearching = false;
  showMore();
}

function showMore(): void {
  const toShow = currentResults.slice(displayedCount, displayedCount + ITEMS_PER_PAGE);
  renderResults(toShow, displayedCount > 0);
  displayedCount += toShow.length;

  if (displayedCount < currentResults.length) {
    loadMoreBtn.style.display = 'block';
    loadMoreBtn.textContent = `Load more (${currentResults.length - displayedCount} remaining)`;
  } else {
    loadMoreBtn.style.display = 'none';
  }
}

// ============== EVENT LISTENERS ==============

suggestionsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest('.suggestion-item') as HTMLElement;
  if (item) selectFolder(item.dataset.folder!);
});

loadMoreBtn.addEventListener('click', showMore);

const sourceFilterEl = document.getElementById('filter-source') as HTMLSelectElement | null;
const boardFilterEl = document.getElementById('filter-board') as HTMLSelectElement | null;
const folderFilterEl = document.getElementById('filter-folder') as HTMLSelectElement | null;
const timeFilterEl = document.getElementById('filter-time') as HTMLSelectElement | null;

[sourceFilterEl, boardFilterEl, folderFilterEl, timeFilterEl].forEach((el) => {
  el?.addEventListener('change', () => {
    applyFilterFromControls();
    if (searchInput.value.trim()) {
      performSearch();
    }
  });
});

filterAddBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  filterMenuEl.classList.toggle('active');
  updateFilterOptions();
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('.filter-dropdown')) {
    filterMenuEl.classList.remove('active');
  }
});

filterChipsEl?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const removeKey = target.getAttribute('data-remove');
  if (!removeKey) return;

  if (removeKey === 'source') {
    selectedSourceFilter = 'all';
  }
  if (removeKey === 'board') {
    selectedBoardFilter = null;
  }
  if (removeKey === 'folder') {
    selectedFolderFilter = null;
    if (currentFolder) {
      currentFolder = null;
    }
  }
  if (removeKey === 'time') {
    selectedTimeFilter = 'all';
  }

  updateFilterOptions();
  if (searchInput.value.trim()) {
    performSearch();
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (!suggestionsEl.classList.contains('active')) return;

  const items = suggestionsEl.querySelectorAll('.suggestion-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, items.length - 1);
    items.forEach((item, i) => item.classList.toggle('selected', i === selectedSuggestionIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, 0);
    items.forEach((item, i) => item.classList.toggle('selected', i === selectedSuggestionIndex));
  } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
    e.preventDefault();
    selectFolder((items[selectedSuggestionIndex] as HTMLElement).dataset.folder!);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

let debounceTimer: number;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const value = searchInput.value;

  const atIndex = value.lastIndexOf('@');
  if (atIndex !== -1) {
    showSuggestions(value.substring(atIndex + 1));
    return;
  } else {
    hideSuggestions();
  }

  debounceTimer = window.setTimeout(performSearch, 350); // Increased debounce for better typing experience
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('.search-wrapper')) {
    hideSuggestions();
  }
});

// Handle image load/error via event delegation
resultsEl.addEventListener('load', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('card-screenshot')) {
    target.classList.remove('loading');
    target.classList.add('loaded');
    const placeholder = target.parentElement?.querySelector('.placeholder') as HTMLElement;
    if (placeholder) placeholder.style.display = 'none';
  }
}, true);

resultsEl.addEventListener('error', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('card-screenshot')) {
    target.style.display = 'none';
  } else if (target.classList.contains('placeholder-favicon')) {
    target.style.visibility = 'hidden';
  }
}, true);

// ============== INTEGRATIONS UI ==============
let pinterestPollingInterval: number | null = null;

integrationsToggle.addEventListener('click', () => {
  integrationsSection.classList.toggle('active');
  if (integrationsSection.classList.contains('active')) {
    updatePinterestUI();
    updatePinterestBoardsUI();
  }
});

closeIntegrations.addEventListener('click', () => {
  integrationsSection.classList.remove('active');
});

// Close board selection
closeBoardSelection.addEventListener('click', () => {
  boardSelection.classList.remove('active');
});

function setPinterestCtaText(text: string): void {
  pinterestConnect.textContent = text || 'Sync Pinterest';
}

pinterestConnect.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest connect clicked');

  try {
    await openPinterestActiveSync();
  } catch (error) {
    console.error('[OpenMemory] Pinterest connect error:', error);
    alert('Error connecting to Pinterest. Check the console for details.');
  }
});

// ============== PINTEREST IMPORT CURRENT BOARD ==============
pinterestImportBtn?.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest import current board clicked');

  // Reset UI
  pinterestImportResult.style.display = 'none';
  pinterestImportProgress.style.display = 'block';
  pinterestImportProgressFill.style.width = '0%';
  pinterestImportStatus.textContent = 'Starting import...';
  pinterestImportStatus.style.color = '#fbbf24';
  pinterestImportBtn.disabled = true;
  pinterestImportBtn.textContent = 'Importing...';

  try {
    const deepSync = pinterestDeepSync?.checked ?? true;
    const maxPins = deepSync ? 2000 : 1200;
    const result = await chrome.runtime.sendMessage({
      type: 'PINTEREST_IMPORT_CURRENT_BOARD',
      maxPins
    });

    pinterestImportProgress.style.display = 'none';

    if (result?.success) {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(74, 222, 128, 0.1)';
      pinterestImportResult.style.color = '#4ade80';
      pinterestImportResult.innerHTML = `
        <strong>Import successful!</strong><br>
        Board: ${result.boardName || 'Unknown'}<br>
        Pins extracted: ${result.pinsExtracted}<br>
        Pins uploaded: ${result.pinsUploaded}
        ${result.pinsFailed > 0 ? `<br>Failed: ${result.pinsFailed}` : ''}
      `;

      // Refresh the search data
      await initializeSearch();
      updatePinterestUI();
    } else {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
      pinterestImportResult.style.color = '#f87171';
      pinterestImportResult.textContent = result?.error || 'Import failed';
    }
  } catch (error) {
    console.error('[OpenMemory] Pinterest import error:', error);
    pinterestImportProgress.style.display = 'none';
    pinterestImportResult.style.display = 'block';
    pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
    pinterestImportResult.style.color = '#f87171';
    pinterestImportResult.textContent = error instanceof Error ? error.message : 'Import failed';
  } finally {
    pinterestImportBtn.disabled = false;
    pinterestImportBtn.textContent = 'Import';
  }
});

// Listen for import progress updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PINTEREST_IMPORT_PROGRESS_UPDATE' && message.progress) {
    const { status, pinsCollected, message: statusMessage } = message.progress;

    if (pinterestImportProgress.style.display !== 'none') {
      const percent = Math.min(95, pinsCollected / 3); // Rough estimate
      pinterestImportProgressFill.style.width = `${percent}%`;
      pinterestImportStatus.textContent = statusMessage || `Importing... ${pinsCollected} pins`;

      if (status === 'complete') {
        pinterestImportProgressFill.style.width = '100%';
        pinterestImportStatus.style.color = '#4ade80';
      } else if (status === 'error') {
        pinterestImportStatus.style.color = '#f87171';
      }
    }
  }
});

async function openPinterestActiveSync(): Promise<void> {
  const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });

  if (status?.syncStatus === 'syncing') {
    console.log('[OpenMemory] Already syncing');
    return;
  }

  // Check if logged in first
  const loginStatus = await chrome.runtime.sendMessage({ type: 'CHECK_PINTEREST_LOGIN' });
  if (!loginStatus?.loggedIn) {
    // Open Pinterest to let user log in
    const tab = await chrome.tabs.create({ url: 'https://www.pinterest.com/login/', active: true });
    alert('Please log in to Pinterest, then click the sync button again.');
    return;
  }

  const stored = await chrome.storage.local.get('pinterestUsername');
  let username = stored?.pinterestUsername as string | undefined;

  if (!username) {
    const manualUsername = prompt(
      'Please enter your Pinterest username to sync:\n' +
      '(You can find it in your Pinterest profile URL: pinterest.com/YOUR_USERNAME)'
    );

    if (!manualUsername || manualUsername.trim() === '') {
      return;
    }

    username = manualUsername.trim();
    await chrome.storage.local.set({ pinterestUsername: username });
  }

  const deepSync = pinterestDeepSync?.checked ?? true;
  if (deepSync) {
    setPinterestCtaText('Syncing...');
    pinterestStatus.textContent = 'Syncing (deep)...';
    pinterestStatus.className = 'integration-status syncing';
    pinterestProgress.classList.add('active');

    console.log('[OpenMemory] Starting deep Pinterest sync for:', username);
    chrome.runtime.sendMessage({ type: 'TRIGGER_PINTEREST_SYNC', username, deepSync: true });
    startPinterestPolling();
    return;
  }

  // Fast sync (API-based, fewer pins)
  setPinterestCtaText('Syncing...');
  pinterestStatus.textContent = 'Syncing via API...';
  pinterestStatus.className = 'integration-status syncing';
  pinterestProgress.classList.add('active');

  console.log('[OpenMemory] Starting fast Pinterest sync for:', username);
  chrome.runtime.sendMessage({ type: 'FAST_PINTEREST_SYNC', username });
  startPinterestPolling();
}

// Function to discover boards and show selection UI
async function discoverAndShowBoards(): Promise<void> {
  pinterestStatus.textContent = 'Checking Pinterest login...';
  pinterestStatus.className = 'integration-status syncing';
  pinterestConnect.textContent = 'Connecting...';
  pinterestConnect.className = 'connect-btn syncing';
  integrationsSection.classList.add('active');

  try {
    // First check if logged in
    const loginStatus = await chrome.runtime.sendMessage({ type: 'CHECK_PINTEREST_LOGIN' });

    if (!loginStatus?.loggedIn) {
      alert('Please log in to Pinterest in your browser first, then try again.');
      updatePinterestUI();
      return;
    }

    pinterestStatus.textContent = 'Extracting username...';

    let manualEntryUsed = false;

    // Discover boards - username will be auto-extracted if not provided
    let result = await chrome.runtime.sendMessage({
      type: 'DISCOVER_PINTEREST_BOARDS'
      // No username needed - will be auto-extracted
    });

    // If auto-extraction failed, ask user for their username
    if (!result || result.loggedOut) {
      alert('Please log in to Pinterest in your browser first, then try again.');
      updatePinterestUI();
      return;
    }

    if (!result.username) {
      const manualUsername = prompt(
        'Could not detect your Pinterest username automatically.\n\n' +
        'Please enter your Pinterest username:\n' +
        '(You can find it in your Pinterest profile URL: pinterest.com/YOUR_USERNAME)'
      );

      if (!manualUsername || manualUsername.trim() === '') {
        alert('Username is required to connect Pinterest.');
        updatePinterestUI();
        return;
      }

      const manualValue = manualUsername.trim();
      manualEntryUsed = true;
      await chrome.storage.local.set({ pinterestUsername: manualValue });

      // Retry with manual username
      pinterestStatus.textContent = `Discovering boards for @${manualValue}...`;
      result = await chrome.runtime.sendMessage({
        type: 'DISCOVER_PINTEREST_BOARDS',
        username: manualValue
      });
    }

    if (!result) {
      alert('Could not connect to Pinterest. Make sure you are logged in.');
      updatePinterestUI();
      return;
    }

    if (!result.boards || result.boards.length === 0) {
      alert(`Connected as ${result.username}, but no boards found. Create some boards on Pinterest first.`);
      updatePinterestUI();
      return;
    }

    discoveredBoards = result.boards;
    discoveredUsername = result.username;
    boardCount.textContent = discoveredBoards.length.toString();

    // Render board list with checkboxes
    boardList.innerHTML = discoveredBoards.map((board, index) => `
      <label class="board-item">
        <input type="checkbox" data-index="${index}" checked>
        <span>${board.name}</span>
      </label>
    `).join('');

    // Show board selection
    boardSelection.classList.add('active');
    pinterestStatus.textContent = `@${result.username} - ${discoveredBoards.length} boards found`;
    pinterestConnect.textContent = 'Select Boards';
    pinterestConnect.className = 'connect-btn';

    // If user manually entered username, auto-trigger sync for all boards
    if (manualEntryUsed) {
      await chrome.runtime.sendMessage({
        type: 'TRIGGER_PINTEREST_SYNC',
        username: result.username,
        boards: discoveredBoards
      });
      startPinterestPolling();
    }

  } catch (error) {
    console.error('[OpenMemory] Board discovery failed:', error);
    alert('Failed to discover boards. Check console for details.');
    updatePinterestUI();
  }
}

// Select all boards
selectAllBoards.addEventListener('click', () => {
  const checkboxes = boardList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  checkboxes.forEach(cb => cb.checked = !allChecked);
});

// Sync selected boards
syncSelectedBoards.addEventListener('click', async () => {
  const checkboxes = boardList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index || '0'));
  const selectedBoards = selectedIndices.map(i => discoveredBoards[i]);

  if (selectedBoards.length === 0) {
    alert('Please select at least one board to sync.');
    return;
  }

  // Use the username discovered earlier
  if (!discoveredUsername) {
    alert('Could not get Pinterest username. Please try connecting again.');
    updatePinterestUI();
    return;
  }

  console.log('[OpenMemory] Syncing', selectedBoards.length, 'selected boards for user:', discoveredUsername);

  // Hide board selection
  boardSelection.classList.remove('active');

  // Update UI for syncing
  pinterestStatus.textContent = `Syncing ${selectedBoards.length} boards...`;
  pinterestStatus.className = 'integration-status syncing';
  pinterestConnect.textContent = 'Syncing...';
  pinterestConnect.className = 'connect-btn syncing';
  pinterestProgress.classList.add('active');
  pinterestSyncStats.classList.add('active');
  pinterestBoardTotal.textContent = `Boards: ${selectedBoards.length}`;
  pinterestBoardUpdated.textContent = 'Updated: 0';
  pinterestBoardArchived.textContent = 'Archived: 0';

  // Start sync with selected boards
  await chrome.runtime.sendMessage({
    type: 'TRIGGER_PINTEREST_SYNC',
    username: discoveredUsername,
    boards: selectedBoards
  });

  startPinterestPolling();
});

async function updatePinterestUI(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });
    const pins = await chrome.runtime.sendMessage({ type: 'GET_ALL_PINS' });
    const existingPinCount = pins?.length || 0;

    if (!status) {
      if (existingPinCount > 0) {
        pinterestStatus.textContent = `${existingPinCount} pins synced`;
        pinterestStatus.className = 'integration-status';
        } else {
          pinterestStatus.textContent = 'Not connected';
          pinterestStatus.className = 'integration-status';
        }
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
        pinterestProgress.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      await updatePinterestBoardsUI();
      return;
    }

      if (status.syncStatus === 'syncing') {
      pinterestStatus.textContent = `Syncing...`;
      pinterestStatus.className = 'integration-status syncing';
      setPinterestCtaText('Syncing...');
      pinterestConnect.className = 'connect-btn syncing';
      pinterestProgress.classList.add('active');
      pinterestProgressFill.style.width = `${status.syncProgress || 0}%`;
      if (!status.syncProgress) {
  pinterestProgressText.textContent = 'Syncing boards... please wait';
  setPinterestCtaText('Sync Pinterest');
      } else {
        pinterestProgressText.textContent = `Syncing pins... ${status.syncProgress || 0}%`;
      }
      pinterestSyncStats.classList.add('active');
      pinterestBoardTotal.textContent = `Boards: ${status.boardTotal ?? 0}`;
      pinterestBoardUpdated.textContent = `Updated: ${status.boardUpdated ?? 0}`;
      pinterestBoardArchived.textContent = `Archived: ${status.boardArchived ?? 0}`;
      integrationsToggle.classList.add('has-connection');
      startPinterestPolling();
    } else if (status.connected) {
      const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleDateString() : 'Never';
      const pinCount = status.totalPins || 0;
      pinterestStatus.textContent = `${status.username || 'Connected'} - ${pinCount} pins (Last: ${lastSync})`;
      pinterestStatus.className = 'integration-status connected';
      setPinterestCtaText('Sync Pinterest');
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.add('active');
      pinterestBoardTotal.textContent = `Boards: ${status.boardTotal ?? 0}`;
      pinterestBoardUpdated.textContent = `Updated: ${status.boardUpdated ?? 0}`;
      pinterestBoardArchived.textContent = `Archived: ${status.boardArchived ?? 0}`;
      integrationsToggle.classList.add('has-connection');
      stopPinterestPolling();
    } else if (status.syncStatus === 'error') {
      pinterestStatus.textContent = 'Sync failed - try again';
      pinterestStatus.className = 'integration-status error';
      setPinterestCtaText('Sync Pinterest');
      pinterestConnect.className = 'connect-btn';
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    } else {
      // Not connected - check if pins exist
      if (existingPinCount > 0) {
        pinterestStatus.textContent = `${existingPinCount} pins synced (connect to continue)`;
        pinterestStatus.className = 'integration-status';
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
      } else {
        pinterestStatus.textContent = 'Not connected';
        pinterestStatus.className = 'integration-status';
        setPinterestCtaText('Sync Pinterest');
        pinterestConnect.className = 'connect-btn';
      }
      pinterestProgress.classList.remove('active');
      pinterestSyncStats.classList.remove('active');
      integrationsToggle.classList.remove('has-connection');
      stopPinterestPolling();
    }
    await updatePinterestBoardsUI();
  } catch (err) {
    console.error('[OpenMemory] Failed to get Pinterest status:', err);
  }
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().trim();
}

// Query expansion with common design synonyms
function expandQuery(query: string): { original: string; expanded: string; terms: string[] } {
  const original = query.toLowerCase().trim();
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

  const words = original.split(/\s+/).filter(w => w.length > 0);
  const expandedTerms = new Set<string>(words);

  // Add synonyms for each word
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

function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => word.length > 0);
}

function computeTextMatchScore(
  title: string | null | undefined,
  board: string | null | undefined,
  terms: string[],
  extraText?: string | null,
  url?: string | null
): number {
  if (!terms.length) return 0;
  const titleText = (title || '').toLowerCase();
  const boardText = (board || '').toLowerCase();
  const extra = (extraText || '').toLowerCase();
  const urlText = (url || '').toLowerCase();
  const query = terms.join(' ').trim();

  // Require minimum 2 characters for meaningful keyword matching
  if (query.length < 2) return 0;

  // Exact title match (highest priority)
  if (titleText === query) return 1.0;

  // Title contains full query
  if (titleText.includes(query)) return 0.8;

  // URL contains full query (e.g., searching "omma" finds "omma.build")
  if (urlText.includes(query)) return 0.75;

  // Expand query for better matching
  const { terms: expandedTerms } = expandQuery(query);
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
  if (boardText.includes(query)) return 0.4;

  // Board contains any original term
  if (terms.some(term => term.length > 2 && boardText.includes(term))) return 0.35;

  // Extra text (description) contains query
  if (extra && extra.includes(query)) return 0.3;

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

function getItemTimestamp(item: SearchableItem): number | null {
  if (item.source === 'chrome') {
    if (item.indexedAt) return item.indexedAt;
    return null;
  }
  if (item.syncedAt) return item.syncedAt;
  return null;
}

function applyFilters(results: HybridResult[], filters: SearchFilters): HybridResult[] {
  let filtered = results;

  if (filters.source === 'bookmarks') {
    filtered = filtered.filter(r => r.source === 'chrome');
  } else if (filters.source === 'pinterest') {
    filtered = filtered.filter(r => r.source === 'pinterest');
  }

  if (filters.board) {
    const boardLower = filters.board.toLowerCase();
    filtered = filtered.filter(r => (r.folder || '').toLowerCase() === boardLower);
  }

  if (filters.folder) {
    const folderLower = filters.folder.toLowerCase();
    filtered = filtered.filter(r => (r.folder || '').toLowerCase().startsWith(folderLower));
  }

  if (filters.time !== 'all') {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    filtered = filtered.filter(r => {
      if (!r.createdAt) return filters.time === 'older';
      return filters.time === 'recent' ? r.createdAt >= cutoff : r.createdAt < cutoff;
    });
  }

  return filtered;
}

function applyRecencyScores(results: HybridResult[]): void {
  const now = Date.now();
  for (const result of results) {
    if (!result.createdAt) {
      result.recencyScore = 0;
      continue;
    }
    const ageMs = now - result.createdAt;
    const normalized = 1 - Math.min(ageMs / RECENT_WINDOW_MS, 1);
    result.recencyScore = Math.max(0, normalized);
  }
}

function updateFilterOptions(): void {
  const sourceFilter = document.getElementById('filter-source') as HTMLSelectElement | null;
  const boardFilter = document.getElementById('filter-board') as HTMLSelectElement | null;
  const folderFilter = document.getElementById('filter-folder') as HTMLSelectElement | null;
  const timeFilter = document.getElementById('filter-time') as HTMLSelectElement | null;

  if (sourceFilter) {
    sourceFilter.value = selectedSourceFilter;
  }

  if (timeFilter) {
    timeFilter.value = selectedTimeFilter;
  }

  if (boardFilter) {
    const boardNames = new Set<string>();
    for (const item of allItems) {
      if (item.source === 'pinterest' && item.boardName) {
        boardNames.add(item.boardName);
      }
    }
    const sorted = Array.from(boardNames).sort((a, b) => a.localeCompare(b));
    const disabled = selectedSourceFilter === 'bookmarks' ? ' disabled' : '';
    boardFilter.innerHTML = ['<option value="">All boards</option>', ...sorted.map(name => {
      const selected = selectedBoardFilter && selectedBoardFilter === name ? ' selected' : '';
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    })].join('');
    boardFilter.disabled = selectedSourceFilter === 'bookmarks';
    if (disabled && selectedBoardFilter) {
      selectedBoardFilter = null;
    }
  }

  if (folderFilter) {
    const folders = new Set<string>();
    for (const item of allItems) {
      if (item.source === 'chrome' && item.folder) {
        folders.add(item.folder);
      }
    }
    const sortedFolders = Array.from(folders).sort((a, b) => a.localeCompare(b));
    folderFilter.innerHTML = ['<option value="">All folders</option>', ...sortedFolders.map(name => {
      const selected = selectedFolderFilter && selectedFolderFilter === name ? ' selected' : '';
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    })].join('');
    folderFilter.disabled = selectedSourceFilter === 'pinterest';
    if (folderFilter.disabled && selectedFolderFilter) {
      selectedFolderFilter = null;
    }
  }

  if (filterBoardSection && filterFolderSection) {
    filterBoardSection.style.display = selectedSourceFilter === 'bookmarks' ? 'none' : 'flex';
    filterFolderSection.style.display = selectedSourceFilter === 'pinterest' ? 'none' : 'flex';
  }

  renderFilterChips();
}

function renderFilterChips(): void {
  if (!filterChipsEl) return;
  const chips: Array<{ label: string; key: string }> = [];

  if (selectedSourceFilter !== 'all') {
    chips.push({
      label: selectedSourceFilter === 'bookmarks' ? 'Bookmarks' : 'Pinterest',
      key: 'source'
    });
  }

  if (selectedBoardFilter && selectedSourceFilter !== 'bookmarks') {
    chips.push({ label: `Board: ${selectedBoardFilter}`, key: 'board' });
  }

  if (selectedFolderFilter && selectedSourceFilter !== 'pinterest') {
    chips.push({ label: `Folder: ${selectedFolderFilter}`, key: 'folder' });
  }

  if (selectedTimeFilter !== 'all') {
    chips.push({
      label: selectedTimeFilter === 'recent' ? 'Recent' : 'Older',
      key: 'time'
    });
  }

  if (chips.length === 0) {
    filterChipsEl.innerHTML = '';
    return;
  }

  filterChipsEl.innerHTML = chips.map(chip => `
    <div class="filter-chip" data-chip="${chip.key}">
      <span>${escapeHtml(chip.label)}</span>
      <button type="button" aria-label="Remove ${escapeHtml(chip.label)}" data-remove="${chip.key}">×</button>
    </div>
  `).join('');
}

function applyFilterFromControls(): void {
  const sourceFilter = document.getElementById('filter-source') as HTMLSelectElement | null;
  const boardFilter = document.getElementById('filter-board') as HTMLSelectElement | null;
  const folderFilter = document.getElementById('filter-folder') as HTMLSelectElement | null;
  const timeFilter = document.getElementById('filter-time') as HTMLSelectElement | null;

  if (sourceFilter) {
    selectedSourceFilter = sourceFilter.value as SourceFilter;
  }

  if (selectedSourceFilter === 'bookmarks') {
    selectedBoardFilter = null;
  }
  if (selectedSourceFilter === 'pinterest') {
    selectedFolderFilter = null;
    currentFolder = null;
  }

  if (boardFilter) {
    selectedBoardFilter = boardFilter.value || null;
  }

  if (folderFilter) {
    selectedFolderFilter = folderFilter.value || null;
  }

  if (timeFilter) {
    selectedTimeFilter = timeFilter.value as TimeFilter;
  }

  updateFilterOptions();
}

async function updatePinterestBoardsUI(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_BOARDS_SUPABASE' });
    if (!response?.success || !Array.isArray(response.boards)) {
      pinterestBoardsSection.style.display = 'block';
      pinterestBoardsList.innerHTML = '';
      pinterestBoardsMessage.textContent = response?.error
        ? response.error
        : 'No boards imported yet';
      pinterestBoardsMessage.style.color = '#fbbf24';
      pinterestBoardsMessage.style.display = 'block';
      return;
    }

    const boards = response.boards as PinterestBoardRow[];
    if (boards.length === 0) {
      pinterestBoardsSection.style.display = 'block';
      pinterestBoardsList.innerHTML = '';
      pinterestBoardsMessage.textContent = 'No boards imported yet';
      pinterestBoardsMessage.style.color = '#fbbf24';
      pinterestBoardsMessage.style.display = 'block';
      return;
    }

    pinterestBoardsSection.style.display = 'block';
    pinterestBoardsMessage.style.display = 'none';
    pinterestBoardsMessage.style.color = '#4ade80';
    pinterestBoardsList.innerHTML = boards.map((board) => {
      const lastSynced = board.last_synced_at
        ? formatRelativeTime(board.last_synced_at)
        : 'Never';
      const totalPins = typeof board.total_pins === 'number' ? board.total_pins : '-';
      const importedPins = typeof board.imported_pins === 'number' ? board.imported_pins : 0;
      const encodedBoardUrl = encodeURIComponent(board.board_url);
      const encodedBoardName = encodeURIComponent(board.board_name || 'Pinterest');

      return `
        <div class="board-row" data-board-url="${encodedBoardUrl}">
          <div class="board-meta">
            <div class="board-name" title="${escapeHtml(board.board_name || 'Untitled')}">${escapeHtml(board.board_name || 'Untitled')}</div>
            <div class="board-stats">Total: ${totalPins}</div>
            <div class="board-stats">Imported: ${importedPins}</div>
            <div class="board-sync">Last synced: ${escapeHtml(lastSynced)}</div>
          </div>
          <div class="board-action">
            <button class="resync-btn" data-board-url="${encodedBoardUrl}" data-board-name="${encodedBoardName}">Resync</button>
            <button class="delete-board-btn" data-board-url="${encodedBoardUrl}" data-board-name="${encodedBoardName}" title="Delete all pins from this board">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    pinterestBoardsSection.style.display = 'block';
    pinterestBoardsList.innerHTML = '';
    pinterestBoardsMessage.textContent = 'Failed to load boards';
    pinterestBoardsMessage.style.color = '#fbbf24';
    pinterestBoardsMessage.style.display = 'block';
  }
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = Math.max(0, now - then);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

pinterestBoardsList?.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;

  // ── Delete board ──────────────────────────────────────────────────────────
  const deleteBtn = target.closest('.delete-board-btn') as HTMLButtonElement | null;
  if (deleteBtn) {
    const boardName = deleteBtn.dataset.boardName ? decodeURIComponent(deleteBtn.dataset.boardName) : '';
    if (!boardName) return;
    if (!confirm(`Delete all pins from "${boardName}"?\nThis cannot be undone.`)) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting...';
    pinterestBoardsMessage.style.display = 'none';

    try {
      const config = await getSupabaseConfig();
      if (!config) throw new Error('Supabase not configured');

      const headers = {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      };

      // Delete all pins for this board from Supabase
      const res = await fetch(
        `${config.url}/rest/v1/pinterest_pins?board_name=eq.${encodeURIComponent(boardName)}`,
        { method: 'DELETE', headers }
      );
      if (!res.ok) throw new Error(`Supabase delete failed: ${res.status}`);

      // Remove the board entry from the local backend SQLite so it disappears from the list
      await fetch(
        `http://localhost:3000/board?board_name=${encodeURIComponent(boardName)}`,
        { method: 'DELETE' }
      ).catch(() => { /* non-critical — board will still be removed from Supabase */ });

      pinterestBoardsMessage.textContent = `Deleted all pins from "${boardName}"`;
      pinterestBoardsMessage.style.color = '#4ade80';
      pinterestBoardsMessage.style.display = 'block';
      await updatePinterestBoardsUI();
    } catch (error) {
      pinterestBoardsMessage.textContent = error instanceof Error ? error.message : 'Delete failed';
      pinterestBoardsMessage.style.color = '#f87171';
      pinterestBoardsMessage.style.display = 'block';
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
    return;
  }

  // ── Resync board ──────────────────────────────────────────────────────────
  const button = target.closest('.resync-btn') as HTMLButtonElement | null;
  if (!button) return;

  const boardUrl = button.dataset.boardUrl ? decodeURIComponent(button.dataset.boardUrl) : undefined;
  const boardName = button.dataset.boardName ? decodeURIComponent(button.dataset.boardName) : 'Pinterest';
  if (!boardUrl) return;

  button.disabled = true;
  button.textContent = 'Resyncing...';
  pinterestBoardsMessage.style.display = 'none';

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'RESYNC_PINTEREST_BOARD',
      boardUrl,
      boardName
    });

    if (result?.success) {
      pinterestBoardsMessage.textContent = `Added ${result.added} new pins`;
      pinterestBoardsMessage.style.color = '#4ade80';
      pinterestBoardsMessage.style.display = 'block';
      await initializeSearch();
      await updatePinterestBoardsUI();
    } else {
      pinterestBoardsMessage.textContent = result?.error || 'Resync failed';
      pinterestBoardsMessage.style.color = '#f87171';
      pinterestBoardsMessage.style.display = 'block';
    }
  } catch (error) {
    pinterestBoardsMessage.textContent = error instanceof Error ? error.message : 'Resync failed';
    pinterestBoardsMessage.style.color = '#f87171';
    pinterestBoardsMessage.style.display = 'block';
  } finally {
    button.disabled = false;
    button.textContent = 'Resync';
  }
});

// ============== PINTEREST EMBEDDINGS BACKFILL ==============

// ============== PINTEREST RESYNC CURRENT BOARD ==============
pinterestResyncBtn?.addEventListener('click', async () => {
  console.log('[OpenMemory] Pinterest resync current board clicked');

  pinterestImportResult.style.display = 'none';
  pinterestImportProgress.style.display = 'block';
  pinterestImportProgressFill.style.width = '0%';
  pinterestImportStatus.textContent = 'Resyncing board...';
  pinterestImportStatus.style.color = '#fbbf24';
  pinterestResyncBtn.disabled = true;
  pinterestResyncBtn.textContent = 'Resyncing...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.includes('pinterest.com')) {
      throw new Error('Please open a Pinterest board page first');
    }

    const result = await chrome.runtime.sendMessage({
      type: 'RESYNC_PINTEREST_BOARD',
      boardUrl: tab.url
    });

    pinterestImportProgress.style.display = 'none';

    if (result?.success) {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(74, 222, 128, 0.1)';
      pinterestImportResult.style.color = '#4ade80';
      pinterestImportResult.innerHTML = `
        <strong>Resync complete!</strong><br>
        Added ${result.added} new pins<br>
        Total stored: ${result.total}
      `;

      await initializeSearch();
      updatePinterestUI();
    } else {
      pinterestImportResult.style.display = 'block';
      pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
      pinterestImportResult.style.color = '#f87171';
      pinterestImportResult.textContent = result?.error || 'Resync failed';
    }
  } catch (error) {
    pinterestImportProgress.style.display = 'none';
    pinterestImportResult.style.display = 'block';
    pinterestImportResult.style.background = 'rgba(248, 113, 113, 0.1)';
    pinterestImportResult.style.color = '#f87171';
    pinterestImportResult.textContent = error instanceof Error ? error.message : 'Resync failed';
  } finally {
    pinterestResyncBtn.disabled = false;
    pinterestResyncBtn.textContent = 'Resync';
  }
});

function startPinterestPolling(): void {
  if (pinterestPollingInterval) return;

  pinterestPollingInterval = window.setInterval(async () => {
    await updatePinterestUI();

    // Check if sync completed
    const status = await chrome.runtime.sendMessage({ type: 'GET_PINTEREST_STATUS' });
    if (status?.syncStatus !== 'syncing') {
      stopPinterestPolling();
      // Refresh search data after sync completes
      await initializeSearch();
    }
  }, 2000);
}

function stopPinterestPolling(): void {
  if (pinterestPollingInterval) {
    clearInterval(pinterestPollingInterval);
    pinterestPollingInterval = null;
  }
}

// Pinterest reset button - clears all pins and checkpoints for fresh sync
pinterestReset.addEventListener('click', async () => {
  if (confirm('This will delete all synced Pinterest pins and start fresh. Continue?')) {
    try {
      await chrome.runtime.sendMessage({ type: 'RESET_PINTEREST_SYNC' });
      await initializeSearch();
      updatePinterestUI();
      alert('Pinterest sync has been reset. Click Connect to start fresh.');
    } catch (err) {
      console.error('[OpenMemory] Reset failed:', err);
      alert('Failed to reset Pinterest sync.');
    }
  }
});

// Check Pinterest status on load
updatePinterestUI();

// ============== INDEXING TRIGGER ==============

// ============== BOOKMARKS UI ==============
bookmarksSync.addEventListener('click', async () => {
  bookmarksSync.textContent = 'Syncing...';
  bookmarksSync.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_CHROME_BOOKMARKS' });
    if (result?.count > 0) {
      bookmarksStatus.textContent = `Synced ${result.count} new bookmarks`;
      // Refresh search data
      await initializeSearch();
    } else {
      bookmarksStatus.textContent = `${result?.totalCount || 0} bookmarks - up to date`;
    }
    // Update count display
    await updateBookmarksUI();
  } catch (err) {
    console.error('[OpenMemory] Bookmark sync failed:', err);
    bookmarksStatus.textContent = 'Sync failed';
  }

  bookmarksSync.textContent = 'Sync';
  bookmarksSync.disabled = false;
});

async function updateBookmarksUI(): Promise<void> {
  try {
    // Get actual Chrome bookmark count (not local DB count)
    const result = await chrome.runtime.sendMessage({ type: 'GET_CHROME_BOOKMARK_COUNT' });
    const chromeCount = result?.count || 0;
    bookmarksStatus.textContent = `${chromeCount} bookmarks`;

    // Also update the main count display
    const pinsCount = allItems.filter(i => i.source === 'pinterest').length;
    if (pinsCount > 0 && chromeCount > 0) {
      itemCountEl.textContent = `${chromeCount} 📚 ${pinsCount} 📌`;
    } else if (pinsCount > 0) {
      itemCountEl.textContent = `${pinsCount} pins`;
    } else {
      itemCountEl.textContent = `${chromeCount} items`;
    }
  } catch (err) {
    // Fallback to local count
    const bookmarkCount = allItems.filter(i => i.source === 'chrome').length;
    bookmarksStatus.textContent = `${bookmarkCount} bookmarks`;
  }
}

// Update bookmarks UI on load
setTimeout(updateBookmarksUI, 500);

// ============== SUPABASE SETTINGS UI ==============
const supabaseCard = document.getElementById('supabase-card');
const supabaseStatus = document.getElementById('supabase-status');
const supabaseToggleSettings = document.getElementById('supabase-toggle-settings');
const supabaseSettings = document.getElementById('supabase-settings');
const supabaseUrlInput = document.getElementById('supabase-url') as HTMLInputElement;
const supabaseKeyInput = document.getElementById('supabase-key') as HTMLInputElement;
const supabaseSaveBtn = document.getElementById('supabase-save');
const supabaseCancelBtn = document.getElementById('supabase-cancel');

async function updateSupabaseUI(): Promise<void> {
  const config = await getSupabaseConfig();
  if (config) {
    supabaseStatus!.textContent = 'Connected - AI Search enabled';
    supabaseStatus!.className = 'integration-status connected';
    supabaseToggleSettings!.textContent = 'Edit';
    supabaseUrlInput!.value = config.url;
    supabaseKeyInput!.value = config.anonKey;
    isSupabaseAvailable = true;
  } else {
    supabaseStatus!.textContent = 'Not configured';
    supabaseStatus!.className = 'integration-status';
    supabaseToggleSettings!.textContent = 'Configure';
    isSupabaseAvailable = false;
  }
  updateSearchModeUI();
}

supabaseToggleSettings?.addEventListener('click', () => {
  const isVisible = supabaseSettings!.style.display !== 'none';
  supabaseSettings!.style.display = isVisible ? 'none' : 'block';
  supabaseToggleSettings!.textContent = isVisible ? (isSupabaseAvailable ? 'Edit' : 'Configure') : 'Hide';
});

supabaseCancelBtn?.addEventListener('click', () => {
  supabaseSettings!.style.display = 'none';
  supabaseToggleSettings!.textContent = isSupabaseAvailable ? 'Edit' : 'Configure';
});

supabaseSaveBtn?.addEventListener('click', async () => {
  const url = supabaseUrlInput!.value.trim();
  const key = supabaseKeyInput!.value.trim();

  if (!url || !key) {
    alert('Please enter both URL and Anon Key');
    return;
  }

  if (!url.startsWith('https://') || !url.includes('.supabase.co')) {
    alert('Invalid Supabase URL. Should be like: https://xxx.supabase.co');
    return;
  }

  if (!key.startsWith('eyJ')) {
    alert('Invalid Anon Key. Should start with eyJ...');
    return;
  }

  // Save to storage
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ supabaseUrl: url, supabaseAnonKey: key }, () => {
      resolve();
    });
  });

  // Update UI
  supabaseSettings!.style.display = 'none';
  await updateSupabaseUI();

  alert('Supabase configured! AI Search is now available.');
});


// ============== INITIALIZE ==============
initializeSearch();

// Check Supabase availability and update UI
updateSupabaseUI();
