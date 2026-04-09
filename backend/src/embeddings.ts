/**
 * Embedding Module
 *
 * Calls the persistent Python embed_server.py via HTTP.
 * Model is loaded once at startup — no per-request spawning.
 *
 * Text Model: BAAI/bge-small-en-v1.5 (384 dimensions)
 */

export const TEXT_EMBEDDING_DIM = 384;

const EMBED_SERVER_PORT = process.env.EMBED_SERVER_PORT || '3002';
const EMBED_SERVER_URL = `http://127.0.0.1:${EMBED_SERVER_PORT}`;

async function callEmbedServer(endpoint: string, text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${EMBED_SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.error(`[Embeddings] Server error ${response.status}`);
      return null;
    }

    const data = await response.json() as { embedding: number[]; dimension: number };
    return data.embedding;
  } catch (err) {
    console.error('[Embeddings] Failed to call embed server:', err);
    return null;
  }
}

/**
 * Generate query embedding (uses query_embed for better retrieval)
 */
export async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  return callEmbedServer('/embed/query', query);
}

/**
 * Generate text embedding
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  return callEmbedServer('/embed/text', text);
}

/**
 * Generate batch text embeddings
 */
export async function generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = [];
  for (const text of texts) {
    results.push(await callEmbedServer('/embed/text', text));
  }
  return results;
}

/**
 * Check if embed server is available
 */
export async function checkEmbedServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${EMBED_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
