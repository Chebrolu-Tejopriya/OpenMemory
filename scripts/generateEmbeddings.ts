/**
 * Embedding Backfill Script
 *
 * Uses FastEmbed Python for both text and image embeddings:
 * - Text: BAAI/bge-small-en-v1.5 (384 dim)
 * - Image: Qdrant/clip-ViT-B-32-vision (512 dim)
 *
 * Prerequisites:
 *   cd backend/python && pip install -r requirements.txt
 *
 * Run: npm run embeddings:backfill
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

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
const TEXT_EMBEDDING_DIM = 384;
const IMAGE_EMBEDDING_DIM = 512;

const PYTHON_SCRIPT = path.join(__dirname, '..', 'backend', 'python', 'embed.py');

/**
 * Call Python FastEmbed script
 */
async function callPython(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = spawn('python', [PYTHON_SCRIPT, command, input], {
      cwd: path.dirname(PYTHON_SCRIPT),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}

/**
 * Generate text embedding using FastEmbed
 */
async function generateTextEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await callPython('text', text);
    const parsed = JSON.parse(result);
    return parsed.embedding || null;
  } catch (error) {
    console.error('Text embedding failed:', error);
    return null;
  }
}

/**
 * Generate image embedding using FastEmbed CLIP
 */
async function generateImageEmbedding(imageUrl: string): Promise<number[] | null> {
  try {
    const result = await callPython('image', imageUrl);
    const parsed = JSON.parse(result);
    return parsed.embedding || null;
  } catch (error) {
    console.error('Image embedding failed:', error);
    return null;
  }
}

/**
 * Generate batch image embeddings using FastEmbed CLIP
 */
async function generateImageEmbeddingsBatch(imageUrls: string[]): Promise<(number[] | null)[]> {
  try {
    const result = await callPython('batch-image', JSON.stringify(imageUrls));
    const parsed = JSON.parse(result);
    return parsed.embeddings || imageUrls.map(() => null);
  } catch (error) {
    console.error('Batch image embedding failed:', error);
    return imageUrls.map(() => null);
  }
}

/**
 * Clean Pinterest title text
 */
function cleanTitle(title: string): string {
  return title
    .replace(/^this may contain:\s*/i, '')
    .replace(/^this contains an image of:\s*/i, '')
    .replace(/^this contains:\s*/i, '')
    .trim();
}

/**
 * Build embedding text from Pinterest pin metadata
 */
function buildEmbeddingText(row: {
  title: string | null;
  board_name: string | null;
  description: string | null;
}): string {
  const bannedPhrases = new Set(['image', 'photo', 'this', 'contains']);

  const titleText = cleanTitle(row.title || '');
  const boardText = row.board_name || '';
  const descriptionText = row.description || '';
  const categoryText = 'UI design inspiration';
  const useCaseText = 'web app design';

  const parts = [titleText, boardText, descriptionText, categoryText, useCaseText]
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .filter(part => !bannedPhrases.has(part.toLowerCase()));

  return parts.length > 0
    ? parts.join(', ')
    : `${boardText}, ${categoryText}, ${useCaseText}`.trim();
}

/**
 * Backfill text embeddings for Pinterest pins
 */
async function backfillPinterestTextEmbeddings(): Promise<number> {
  const { data: rows, error } = await supabase
    .from('pinterest_pins')
    .select('id, title, board_name, description, embedding')
    .is('embedding', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Fetch failed:', error.message);
    return 0;
  }

  if (!rows || rows.length === 0) {
    return 0;
  }

  let processed = 0;

  for (const row of rows) {
    const embeddingText = buildEmbeddingText(row);

    if (embeddingText.length === 0) {
      console.log('Skipping empty text:', row.id);
      continue;
    }

    try {
      console.log(`[PIN TEXT] Processing: ${row.id.substring(0, 8)}... - "${embeddingText.substring(0, 40)}..."`);

      const embedding = await generateTextEmbedding(embeddingText);

      if (!embedding) {
        console.log(`[PIN TEXT] ⚠ Skipped (no embedding): ${row.id}`);
        continue;
      }

      if (embedding.length !== TEXT_EMBEDDING_DIM) {
        console.error(`[PIN TEXT] ✗ Wrong dimension: ${embedding.length}, expected ${TEXT_EMBEDDING_DIM}`);
        continue;
      }

      const { error: updateError } = await supabase.rpc('update_embedding', {
        row_id: row.id,
        embedding_input: embedding
      });

      if (updateError) {
        console.error(`[PIN TEXT] ✗ Update failed: ${updateError.message}`);
        continue;
      }

      console.log(`[PIN TEXT] ✓ Updated: ${row.id.substring(0, 8)}...`);
      processed += 1;
    } catch (error) {
      console.error(`[PIN TEXT] ✗ Failed: ${row.id}`, error instanceof Error ? error.message : error);
    }
  }

  return processed;
}

/**
 * Backfill image embeddings for Pinterest pins
 * Uses batch processing for speed
 * Marks failed images with empty array to prevent infinite retry loops
 */
async function backfillPinterestImageEmbeddings(): Promise<number> {
  const { data: rows, error } = await supabase
    .from('pinterest_pins')
    .select('id, image_url, image_embedding')
    .is('image_embedding', null)
    .not('image_url', 'is', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Fetch failed:', error.message);
    return 0;
  }

  if (!rows || rows.length === 0) {
    return 0;
  }

  // Prepare URLs (use /236x/ for best availability)
  const imageUrls = rows.map(row => {
    let url = row.image_url || '';
    if (url.includes('/originals/')) {
      url = url.replace('/originals/', '/236x/');
    } else if (url.includes('/474x/')) {
      url = url.replace('/474x/', '/236x/');
    }
    return url;
  });

  console.log(`[PIN IMAGE] Processing batch of ${rows.length} images...`);

  // Generate embeddings in batch (parallel downloads + batch inference)
  const embeddings = await generateImageEmbeddingsBatch(imageUrls);

  let processed = 0;
  let success = 0;
  let failed = 0;

  // Update database with results
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const embedding = embeddings[i];

    try {
      if (!embedding || embedding.length !== IMAGE_EMBEDDING_DIM) {
        // Mark as failed with a dummy embedding (all zeros) so it won't retry
        const dummyEmbedding = new Array(IMAGE_EMBEDDING_DIM).fill(0);
        await supabase.rpc('update_image_embedding', {
          row_id: row.id,
          embedding_input: dummyEmbedding
        });
        failed++;
      } else {
        // Save embedding
        const { error: updateError } = await supabase.rpc('update_image_embedding', {
          row_id: row.id,
          embedding_input: embedding
        });

        if (updateError) {
          // Mark as failed with zeros
          const zeroEmbed = new Array(IMAGE_EMBEDDING_DIM).fill(0);
          try {
            await supabase.rpc('update_image_embedding', {
              row_id: row.id,
              embedding_input: zeroEmbed
            });
          } catch {}
          failed++;
        } else {
          success++;
        }
      }
      processed++;
    } catch {
      // Mark as failed with zeros
      const zeroEmbed = new Array(IMAGE_EMBEDDING_DIM).fill(0);
      try {
        await supabase.rpc('update_image_embedding', {
          row_id: row.id,
          embedding_input: zeroEmbed
        });
      } catch {}
      processed++;
      failed++;
    }
  }

  console.log(`[PIN IMAGE] Batch done: ${success} success, ${failed} failed`);
  return processed;
}

/**
 * Backfill text embeddings for bookmarks
 */
async function backfillBookmarkEmbeddings(): Promise<number> {
  const { data: rows, error } = await supabase
    .from('bookmarks')
    .select('id, title, folder, embedding')
    .is('embedding', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Fetch failed:', error.message);
    return 0;
  }

  if (!rows || rows.length === 0) {
    return 0;
  }

  let processed = 0;

  for (const row of rows) {
    const embeddingText = [row.title, row.folder].filter(Boolean).join(' - ');

    if (embeddingText.length === 0) {
      console.log('Skipping empty text:', row.id);
      continue;
    }

    try {
      console.log(`[BOOKMARK] Processing: ${row.id.substring(0, 8)}... - "${embeddingText.substring(0, 40)}..."`);

      const embedding = await generateTextEmbedding(embeddingText);

      if (!embedding) {
        console.log(`[BOOKMARK] ⚠ Skipped (no embedding): ${row.id}`);
        continue;
      }

      if (embedding.length !== TEXT_EMBEDDING_DIM) {
        console.error(`[BOOKMARK] ✗ Wrong dimension: ${embedding.length}, expected ${TEXT_EMBEDDING_DIM}`);
        continue;
      }

      const { error: updateError } = await supabase
        .from('bookmarks')
        .update({ embedding: `[${embedding.join(',')}]` })
        .eq('id', row.id);

      if (updateError) {
        console.error(`[BOOKMARK] ✗ Update failed: ${updateError.message}`);
        continue;
      }

      console.log(`[BOOKMARK] ✓ Updated: ${row.id.substring(0, 8)}...`);
      processed += 1;
    } catch (error) {
      console.error(`[BOOKMARK] ✗ Failed: ${row.id}`, error instanceof Error ? error.message : error);
    }
  }

  return processed;
}

async function getRemainingCounts(): Promise<{
  pinterestText: number;
  pinterestImage: number;
  bookmarks: number;
}> {
  const [pinterestText, pinterestImage, bookmarks] = await Promise.all([
    supabase
      .from('pinterest_pins')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null),
    supabase
      .from('pinterest_pins')
      .select('id', { count: 'exact', head: true })
      .is('image_embedding', null)
      .not('image_url', 'is', null),
    supabase
      .from('bookmarks')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null)
  ]);

  return {
    pinterestText: pinterestText.count ?? 0,
    pinterestImage: pinterestImage.count ?? 0,
    bookmarks: bookmarks.count ?? 0
  };
}

async function checkPythonAvailable(): Promise<boolean> {
  try {
    const result = await callPython('text', 'test');
    JSON.parse(result);
    return true;
  } catch (error) {
    console.error('Python FastEmbed not available:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function runEmbeddingBackfill(): Promise<void> {
  console.log('='.repeat(60));
  console.log('FastEmbed Embedding Backfill (Python)');
  console.log('='.repeat(60));
  console.log('Text Model: BAAI/bge-small-en-v1.5 (384 dim)');
  console.log('Image Model: Qdrant/clip-ViT-B-32-vision (512 dim)');
  console.log('='.repeat(60));

  // Check Python is available
  console.log('\nChecking Python FastEmbed...');
  const pythonAvailable = await checkPythonAvailable();
  if (!pythonAvailable) {
    console.error('\n❌ Python FastEmbed not available!');
    console.error('Please run: cd backend/python && pip install -r requirements.txt');
    process.exit(1);
  }
  console.log('✓ Python FastEmbed ready\n');

  const initial = await getRemainingCounts();
  console.log(`Pending embeddings:`);
  console.log(`  - Pinterest text: ${initial.pinterestText}`);
  console.log(`  - Pinterest images: ${initial.pinterestImage}`);
  console.log(`  - Bookmarks: ${initial.bookmarks}`);

  if (initial.pinterestText === 0 && initial.pinterestImage === 0 && initial.bookmarks === 0) {
    console.log('\n✓ All embeddings are up to date!');
    return;
  }

  const startTime = Date.now();

  let totalPinTextProcessed = 0;
  let totalPinImageProcessed = 0;
  let totalBookmarkProcessed = 0;

  // Process Pinterest text embeddings
  if (initial.pinterestText > 0) {
    console.log('\n--- Processing Pinterest text embeddings ---');
    while (true) {
      const processed = await backfillPinterestTextEmbeddings();
      totalPinTextProcessed += processed;
      if (processed === 0) break;
      console.log(`Progress: ${totalPinTextProcessed}/${initial.pinterestText}`);
    }
  }

  // Process Pinterest image embeddings
  if (initial.pinterestImage > 0) {
    console.log('\n--- Processing Pinterest image embeddings ---');
    while (true) {
      const processed = await backfillPinterestImageEmbeddings();
      totalPinImageProcessed += processed;
      if (processed === 0) break;
      console.log(`Progress: ${totalPinImageProcessed}/${initial.pinterestImage}`);
    }
  }

  // Process bookmark embeddings
  if (initial.bookmarks > 0) {
    console.log('\n--- Processing bookmark text embeddings ---');
    while (true) {
      const processed = await backfillBookmarkEmbeddings();
      totalBookmarkProcessed += processed;
      if (processed === 0) break;
      console.log(`Progress: ${totalBookmarkProcessed}/${initial.bookmarks}`);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  console.log('\n' + '='.repeat(60));
  console.log('Backfill Complete!');
  console.log('='.repeat(60));
  console.log(`Pinterest text embeddings: ${totalPinTextProcessed}`);
  console.log(`Pinterest image embeddings: ${totalPinImageProcessed}`);
  console.log(`Bookmark embeddings: ${totalBookmarkProcessed}`);
  console.log(`Total time: ${minutes}m ${seconds}s`);
}

// CLI entry point
const isDirectRun = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isDirectRun) {
  runEmbeddingBackfill().catch((error) => {
    console.error('Embedding backfill failed:', error);
    process.exit(1);
  });
}
