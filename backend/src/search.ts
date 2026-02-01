import { generateEmbeddings } from './embeddings.js';
import { getAllItems } from './db.js';
import { inferQueryIntent, calculateIntentScore, shouldExclude } from './intent.js';
import { Intent } from './types.js';

export interface SearchResult {
  title: string;
  url: string;
  folder: string | null;
  source: string;
  intent: string;
  score: number;
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
const MIN_SCORE_THRESHOLD = 0.3;

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
  folderFilter?: string
): Promise<{ results: SearchResult[]; total: number; hasMore: boolean }> {
  // Step 1: Infer user intent
  const queryIntent = inferQueryIntent(query);

  // Generate embedding for query
  const [queryEmbedding] = await generateEmbeddings([query]);

  // Get all items from database
  const items = getAllItems();

  // Step 2 & 3: Filter and score items
  const scored: SearchResult[] = [];

  for (const item of items) {
    // Folder filter: if specified, only include items from matching folder
    if (folderFilter && (!item.folder || !item.folder.toLowerCase().startsWith(folderFilter.toLowerCase()))) {
      continue;
    }

    // Hard filter: exclude items that violate query intent
    if (shouldExclude(queryIntent, item)) {
      continue;
    }

    // Calculate base similarity
    const baseSimilarity = cosineSimilarity(queryEmbedding, item.embedding);

    // Apply intent-based score adjustment
    const intentMultiplier = calculateIntentScore(queryIntent, item);
    const adjustedScore = baseSimilarity * intentMultiplier;

    scored.push({
      title: item.title,
      url: item.url,
      folder: item.folder,
      source: item.source,
      intent: item.intent,
      score: adjustedScore,
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
