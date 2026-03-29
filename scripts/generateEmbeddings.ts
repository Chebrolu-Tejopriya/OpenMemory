import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const BATCH_SIZE = 50;
let embedderPromise: Promise<any> | null = null;

async function getEmbedder(): Promise<any> {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
}

async function backfillBatch(): Promise<number> {
  const { data: rows, error } = await supabase
    .from('pinterest_pins')
    .select('id, title, board_name')
    .is('embedding', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.log('Fetch failed:', error.message);
    return 0;
  }

  if (!rows || rows.length === 0) {
    return 0;
  }

  let processed = 0;
  const expectedDim = process.env.EMBEDDING_DIM
    ? Number(process.env.EMBEDDING_DIM)
    : 384;

  const embedder = await getEmbedder();

  for (const row of rows) {
    const text = `${row.title || ''} ${row.board_name || ''} pinterest image ui design inspiration`.trim();
    if (!text) {
      console.log('Skipping empty text:', row.id);
      continue;
    }
    console.log('Embedding text:', text);
    try {
      const output = await (embedder as any)(text, {
        pooling: 'mean',
        normalize: true
      } as unknown as any) as any;
      const embedding = Array.from((output as any).data as any) as number[];

      if (!Array.isArray(embedding)) {
        throw new Error('Embedding is not array');
      }
      if (embedding.length !== expectedDim) {
        throw new Error(`Invalid embedding length: ${embedding.length}`);
      }

      console.log('Final embedding length:', embedding.length);

      const { data: updateData, error: updateError } = await supabase
        .from('pinterest_pins')
        .update({ embedding })
        .eq('id', row.id)
        .select();

      console.log({
        id: row.id,
        error: updateError?.message ?? null,
        updated: updateData?.length ?? 0
      });

      const { data: check, error: checkError } = await supabase
        .from('pinterest_pins')
        .select('embedding')
        .eq('id', row.id)
        .single();

      if (checkError) {
        console.log('CHECK FAILED:', row.id, checkError.message);
      } else {
        const storedLength = Array.isArray(check?.embedding) ? check.embedding.length : 0;
        console.log('Stored embedding length:', storedLength);
      }

      if (updateError) {
        console.log('UPDATE FAILED:', row.id, updateError);
      } else if (!updateData || updateData.length === 0) {
        console.log('NO ROW UPDATED:', row.id);
      } else {
        console.log('UPDATED SUCCESS:', row.id);
        processed += 1;
      }
    } catch (error) {
      console.log('Backfill failed:', row.id, error);
    }
  }

  const remaining = await getRemainingCount();
  console.log(`Batch processed: ${processed}, Remaining null embeddings: ${remaining}`);
  return processed;
}

export async function runEmbeddingBackfill(): Promise<void> {
  let totalProcessed = 0;
  while (true) {
    const processed = await backfillBatch();
    totalProcessed += processed;
    console.log(`Processed: ${processed} (total: ${totalProcessed})`);
    if (processed === 0) {
      console.log('No pending embeddings, exiting.');
      break;
    }
  }
}

async function getRemainingCount(): Promise<number> {
  const { count } = await supabase
    .from('pinterest_pins')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);
  return count ?? 0;
}

const isDirectRun = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isDirectRun) {
  runEmbeddingBackfill().catch((error) => {
    console.error('Embedding backfill failed:', error);
    process.exit(1);
  });
}
