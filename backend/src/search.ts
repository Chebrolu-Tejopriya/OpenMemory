import { generateQueryEmbedding } from './embeddings.js';
import { getAllItems, db } from './db.js';
import { inferQueryIntent, calculateIntentScore, shouldExclude } from './intent.js';
import { Intent } from './types.js';

// Cache for Pinterest pin images
const pinterestImageCache = new Map<string, string | null>();

function loadPinterestImages(): void {
  if (pinterestImageCache.size > 0) return;

  const stmt = db.prepare('SELECT pin_url, image FROM pinterest_pins WHERE image IS NOT NULL');
  const rows = stmt.all() as Array<{ pin_url: string; image: string }>;

  for (const row of rows) {
    pinterestImageCache.set(row.pin_url, row.image);
  }
}

function getImageForItem(url: string, source: string): string | null {
  if (source === 'pinterest') {
    loadPinterestImages();
    return pinterestImageCache.get(url) || null;
  }

  // For bookmarks, return a favicon URL
  try {
    const urlObj = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=128`;
  } catch {
    return null;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  folder: string | null;
  source: string;
  intent: string;
  score: number;
  imageUrl: string | null;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Minimum score threshold - results below this are considered irrelevant
const MIN_SCORE_THRESHOLD = 0.05;
const RECENT_DAYS = 30;
const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

/**
 * Calculate keyword match score based on how well the query matches the item.
 * Strict matching - only exact substring matches count.
 */
function calculateKeywordScore(
  query: string,
  title: string,
  folder: string | null,
  url: string
): number {
  const queryLower = query.toLowerCase().trim();
  const titleLower = title.toLowerCase();
  const folderLower = (folder || '').toLowerCase();

  // Extract domain from URL
  let domain = '';
  try {
    domain = new URL(url).hostname.replace('www.', '').toLowerCase();
  } catch {
    // Invalid URL
  }

  // Require minimum 2 characters for meaningful keyword matching
  if (queryLower.length < 2) return 0;

  // Exact full match (highest priority)
  if (titleLower === queryLower) return 1.0;

  // Title contains exact query string
  if (titleLower.includes(queryLower)) return 0.85;

  // Domain contains query (good for site-specific searches)
  if (domain.includes(queryLower)) return 0.75;

  // Folder contains exact query
  if (folderLower.includes(queryLower)) return 0.7;

  // Multi-word query: check if ALL terms appear somewhere
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2);
  if (queryTerms.length > 1) {
    const combined = `${titleLower} ${folderLower} ${domain}`;
    let matchedCount = 0;
    for (const term of queryTerms) {
      if (combined.includes(term)) {
        matchedCount++;
      }
    }
    if (matchedCount === queryTerms.length) {
      return 0.65; // All terms found
    } else if (matchedCount > 0) {
      return 0.4 * (matchedCount / queryTerms.length); // Partial term matches
    }
  }

  return 0;
}

/**
 * Intent-aware semantic search for design inspiration.
 *
 * Steps:
 * 1. Infer user intent from query
 * 2. Apply hard filters to exclude irrelevant content
 * 3. Calculate similarity scores with intent-based adjustments
 * 4. Filter out low-relevance results
 * 5. Return ranked results with pagination
 */
export async function search(
  query: string,
  limit = 20,
  offset = 0,
  folderFilter?: string,
  sourceFilter?: string
): Promise<{ results: SearchResult[]; total: number; hasMore: boolean }> {
  // Step 1: Infer user intent
  const queryIntent = inferQueryIntent(query);

  const normalizedQuery = query.toLowerCase().trim();

  // Generate embedding for query using FastEmbed query mode
  const queryEmbedding = await generateQueryEmbedding(query);

  // Get all items from database
  const items = getAllItems();

  // Step 2 & 3: Filter and score items
  const scored: SearchResult[] = [];

  for (const item of items) {
    // Source filter: if specified, only include items from matching source
    if (sourceFilter && item.source !== sourceFilter) {
      continue;
    }

    // Folder filter: if specified, only include items from matching folder
    if (folderFilter && (!item.folder || !item.folder.toLowerCase().startsWith(folderFilter.toLowerCase()))) {
      continue;
    }

    // Hard filter: exclude items that violate query intent
    if (shouldExclude(queryIntent, item)) {
      continue;
    }

    // Calculate base semantic similarity
    const baseSimilarity = cosineSimilarity(queryEmbedding, item.embedding);

    // Calculate keyword match score (strict matching)
    const keywordScore = calculateKeywordScore(
      normalizedQuery,
      item.title,
      item.folder,
      item.url
    );

    // Recency score
    const createdAtMs = Date.parse(item.created_at);
    const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : RECENT_WINDOW_MS;
    const recencyScore = Math.max(0, 1 - Math.min(ageMs / RECENT_WINDOW_MS, 1));

    // Apply intent-based score adjustment
    const intentMultiplier = calculateIntentScore(queryIntent, item);
    const adjustedSimilarity = baseSimilarity * intentMultiplier;

    // Scoring strategy:
    // - If we have a good keyword match, prioritize it heavily
    // - If no keyword match, require VERY strong semantic similarity
    let adjustedScore: number;

    if (keywordScore > 0) {
      // Good keyword match: weight keyword heavily
      adjustedScore =
        (0.15 * adjustedSimilarity) +
        (0.75 * keywordScore) +
        (0.1 * recencyScore);
    } else {
      // No keyword match: require very high semantic similarity
      // This prevents showing random results when nothing matches the query
      const semanticThreshold = 0.55; // High threshold for pure semantic matches
      if (adjustedSimilarity < semanticThreshold) {
        // Not semantically similar enough without keyword match - skip
        continue;
      }
      adjustedScore =
        (0.8 * adjustedSimilarity) +
        (0.1 * recencyScore) +
        (0.1 * Math.max(0, adjustedSimilarity - semanticThreshold));
    }

    scored.push({
      title: item.title,
      url: item.url,
      folder: item.folder,
      source: item.source,
      intent: item.intent,
      score: adjustedScore,
      imageUrl: getImageForItem(item.url, item.source),
    });
  }

  // Step 4: Sort by adjusted score and filter low-relevance results
  const sorted = scored
    .filter(item => item.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  // Step 5: Apply pagination
  const total = sorted.length;
  const paginated = sorted.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  return { results: paginated, total, hasMore };
}
