import { checkEmbedServerAvailable, generateImageEmbeddings, generateQueryEmbedding, generateTextEmbeddings } from './embeddings.js';
import { enqueueEmbeddingWork } from './pinterest-embeddings.js';

export async function xDatabase(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error('Configure the backend Supabase URL and key for X.');
  const response = await fetch(`${base}/rest/v1/${path}`, { ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`X database request failed (${response.status}). Check the X migration and backend configuration.`);
  return response;
}
export interface XCloudResult { title: string; url: string; folder: string; source: 'x'; score: number; imageUrl: string | null; description?: string; author?: string; similarity?: number; keyword_score?: number }
export async function browseXBookmarks(limit = 500): Promise<{ results: XCloudResult[]; total: number }> {
  const params = new URLSearchParams({ select: 'title,url,account_username,image_url', order: 'created_at.desc,id.desc', limit: String(Math.min(1000, Math.max(1, limit))) });
  const rows = await (await xDatabase(`x_bookmarks?${params}`)).json() as any[];
  const results = rows.map(row => ({ title: row.title, url: row.url, folder: `@${row.account_username}`, source: 'x' as const, score: 1, imageUrl: row.image_url || null }));
  return { results, total: results.length };
}
export async function searchXBookmarks(query: string, limit = 100): Promise<{ results: XCloudResult[]; total: number; hasMore: boolean }> {
  const embedding = await generateQueryEmbedding(query);
  const rows = await (await xDatabase('rpc/search_x_bookmarks', { method: 'POST', body: JSON.stringify({ search_query: query,
    query_embedding: embedding ? `[${embedding.join(',')}]` : null, match_count: Math.min(1000, Math.max(1, limit)) }) })).json() as any[];
  const results = rows.map(row => ({ title: row.title, url: row.url, folder: `@${row.account_username}`, source: 'x' as const,
    score: row.score, imageUrl: row.image_url || null, description: row.description, author: row.author, similarity: row.similarity, keyword_score: row.keyword_score }));
  return { results, total: results.length, hasMore: false };
}
let running: Promise<void> | null = null;
export const xEmbeddingState: { running: boolean; textGenerated: number; imageGenerated: number; error?: string } = { running: false, textGenerated: 0, imageGenerated: 0 };
export async function xEmbeddingCounts() {
  const count = async (column?: string) => {
    const params = new URLSearchParams({ select: 'id' });
    if (column) params.set(column, 'is.null');
    if (column === 'image_embedding') params.set('image_url', 'not.is.null');
    const response = await xDatabase(`x_bookmarks?${params}`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    const value = response.headers.get('content-range')?.split('/')[1];
    if (!value || value === '*') throw new Error('X embedding count is unavailable');
    return Number(value);
  };
  const [total, textMissing, imageMissing] = await Promise.all([count(), count('embedding'), count('image_embedding')]);
  return { total, textMissing, imageMissing };
}
export function startXEmbeddings() {
  if (!running) {
    xEmbeddingState.running = true; xEmbeddingState.error = undefined;
    running = enqueueEmbeddingWork(() => runXEmbeddings()).catch(error => { xEmbeddingState.error = error instanceof Error ? error.message : 'X indexing failed'; })
      .finally(() => { running = null; xEmbeddingState.running = false; });
  }
  return xEmbeddingState;
}
export async function runXEmbeddings(imagesOnly = false): Promise<void> {
  if (!await checkEmbedServerAvailable()) throw new Error('X indexing is waiting for the embedding model. It will retry.');
  const column = imagesOnly ? 'image_embedding' : 'embedding';
  let cursor = '';
  let generated = 0, failed = 0;
  while (true) {
    const params = new URLSearchParams({ select: 'id,title,description,author,image_url,updated_at', [column]: 'is.null', order: 'id.asc', limit: imagesOnly ? '1' : '30' });
    if (imagesOnly) params.set('image_url', 'not.is.null');
    if (cursor) params.set('id', `gt.${cursor}`);
    const rows = await (await xDatabase(`x_bookmarks?${params}`)).json() as any[];
    if (!rows.length) break;
    const vectors = imagesOnly ? await generateImageEmbeddings(rows.map(row => row.image_url))
      : await generateTextEmbeddings(rows.map(row => `${row.title} ${row.description} ${row.author}`.slice(0, 2000)));
    for (const [i, row] of rows.entries()) {
      const vector = vectors[i];
      if (!vector || vector.length !== (imagesOnly ? 512 : 384) || !vector.every(Number.isFinite) || !vector.some(v => v !== 0)) { failed++; continue; }
      // Do not attach a vector to content changed while inference was running.
      const update = new URLSearchParams({ id: `eq.${row.id}`, updated_at: `eq.${row.updated_at}`, [column]: 'is.null', select: 'id' });
      const saved = await (await xDatabase(`x_bookmarks?${update}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ [column]: vector }) })).json() as any[];
      if (saved.length) { generated++; if (imagesOnly) xEmbeddingState.imageGenerated++; else xEmbeddingState.textGenerated++; }
    }
    cursor = rows[rows.length - 1].id;
    console.log(`[X embeddings] ${column}: generated=${generated}, failed=${failed}`);
  }
}
