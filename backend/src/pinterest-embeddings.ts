import { generateTextEmbeddings, generateImageEmbeddings, checkEmbedServerAvailable } from './embeddings.js';

export interface EmbeddingJobStatus {
  running: boolean;
  textGenerated: number;
  imageGenerated: number;
  failed: number;
  phase?: string;
  error?: string;
}
const jobs = new Map<string, EmbeddingJobStatus>();
let workerQueue: Promise<unknown> = Promise.resolve();

function credentials(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase is not configured for the embedding worker');
  return { url, key };
}

async function database(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = credentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try { response = await fetch(`${url}/rest/v1/${path}`, {
      ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(30000)
    }); } catch (error) {
      if (attempt < 2) {
        console.warn(`[Pinterest embeddings] Database ${init.method || 'GET'} attempt ${attempt + 1} failed; retrying.`);
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Supabase ${init.method || 'GET'} request failed after 3 attempts: ${error instanceof Error ? error.message : 'network error'}`);
    }
    if (response.ok) return response;
    if ((response.status >= 500 || response.status === 429) && attempt < 2) {
      await response.text();
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Embedding database request failed (${response.status}): ${(await response.text()).slice(0,300)}`);
  }
  throw new Error('Embedding database is unavailable');
}

export async function pinterestEmbeddingCounts(boardUrl: string): Promise<{ total: number; textMissing: number; imageMissing: number }> {
  const count = async (column?: string): Promise<number> => {
    const query = new URLSearchParams({ select: 'id', board_url: `eq.${boardUrl}` });
    if (column) query.set(column, 'is.null');
    const response = await database(`pinterest_pins?${query}`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    const value = response.headers.get('content-range')?.split('/')[1];
    if (!value || value === '*') throw new Error('Database did not return an exact embedding count');
    return Number(value);
  };
  const [total, textMissing, imageMissing] = await Promise.all([count(), count('embedding'), count('image_embedding')]);
  return { total, textMissing, imageMissing };
}

export function startPinterestEmbeddingJob(boardUrl: string): EmbeddingJobStatus {
  credentials();
  const current = jobs.get(boardUrl);
  if (current?.running) return current;
  const status: EmbeddingJobStatus = { running: true, textGenerated: 0, imageGenerated: 0, failed: 0 };
  jobs.set(boardUrl, status);
  workerQueue = workerQueue.catch(() => undefined).then(() => runPinterestEmbeddingJob(boardUrl, status)).catch(error => {
    status.error = `${status.phase || 'worker'}: ${error instanceof Error ? error.message : 'Embedding worker failed'}`;
    console.error('[Pinterest embeddings]', status.error);
  }).finally(() => { status.running = false; });
  return status;
}

export function getPinterestEmbeddingJob(boardUrl: string): EmbeddingJobStatus | undefined { return jobs.get(boardUrl); }

export async function runPinterestEmbeddingJob(boardUrl: string, status: EmbeddingJobStatus = { running: true, textGenerated: 0, imageGenerated: 0, failed: 0 }): Promise<EmbeddingJobStatus> {
  const phase = (value: string) => { status.phase = value; console.log(`[Pinterest embeddings] ${boardUrl}: ${value}`); };
  phase('waiting for model server');
  // A cold backend can accept imports while its Python model is still loading.
  let ready = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await checkEmbedServerAvailable()) { ready = true; break; }
    if (attempt < 23) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!ready) throw new Error('The embedding model server is not ready; pins remain pending for retry.');
  for (const column of ['embedding', 'image_embedding'] as const) {
    let cursor = '';
    while (true) {
      const query = new URLSearchParams({ select: 'id,title,description,board_name,image_url', board_url: `eq.${boardUrl}`, [column]: 'is.null', order: 'id.asc', limit: column === 'embedding' ? '30' : '4' });
      if (cursor) query.set('id', `gt.${cursor}`);
      phase(`reading pins missing ${column}`);
      const rows = await (await database(`pinterest_pins?${query}`)).json() as Array<{id: string; title?: string; description?: string; board_name?: string; image_url?: string}>;
      if (!rows.length) break;
      phase(`generating ${column} for ${rows.length} pins`);
      const vectors = column === 'embedding'
        ? await generateTextEmbeddings(rows.map(row => [row.title, row.description, row.board_name].filter(Boolean).join(' ').slice(0,2000)))
        : await generateImageEmbeddings(rows.map(row => row.image_url || ''));
      phase(`saving ${column}`);
      // Avoid a burst of database writes competing with inference on small hosts.
      for (const [i, row] of rows.entries()) {
        const vector = vectors[i];
        const dim = column === 'embedding' ? 384 : 512;
        if (!vector || vector.length !== dim || !vector.every(Number.isFinite) || !vector.some(value => value !== 0)) {
          status.failed++; continue; // Keep NULL for retry; never manufacture zero vectors.
        }
        const update = new URLSearchParams({ id: `eq.${rows[i].id}`, board_url: `eq.${boardUrl}`, [column]: 'is.null' });
        await database(`pinterest_pins?${update}`, { method: 'PATCH', body: JSON.stringify({ [column]: vector }), headers: { Prefer: 'return=minimal' } });
        if (column === 'embedding') status.textGenerated++; else status.imageGenerated++;
      }
      cursor = rows[rows.length - 1].id;
      console.log(`[Pinterest embeddings] text=${status.textGenerated}, images=${status.imageGenerated}, failed=${status.failed}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  status.running = false;
  phase('complete');
  return status;
}
