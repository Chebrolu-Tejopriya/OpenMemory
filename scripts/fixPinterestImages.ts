/**
 * Fix Pinterest Image URLs Script
 *
 * 1. Updates /originals/ URLs to /474x/ (accessible by Pinterest)
 * 2. Clears failed image embeddings (empty arrays) so they can be reprocessed
 *
 * Run: npm run fix:pinterest-images
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

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

const BATCH_SIZE = 100;

async function fixImageUrls(): Promise<number> {
  console.log('\n--- Step 1: Fixing image URLs → /236x/ (most accessible) ---\n');

  let totalFixed = 0;

  while (true) {
    // Find pins with /originals/ or /474x/ URLs (convert all to /236x/)
    const { data: rows, error } = await supabase
      .from('pinterest_pins')
      .select('id, image_url')
      .or('image_url.like.%/originals/%,image_url.like.%/474x/%')
      .limit(BATCH_SIZE);

    if (error) {
      console.error('Fetch error:', error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      break;
    }

    // Update each URL to use /236x/ (most accessible)
    for (const row of rows) {
      const newUrl = row.image_url
        .replace('/originals/', '/236x/')
        .replace('/474x/', '/236x/');

      const { error: updateError } = await supabase
        .from('pinterest_pins')
        .update({ image_url: newUrl })
        .eq('id', row.id);

      if (updateError) {
        console.error(`Failed to update ${row.id}:`, updateError.message);
      } else {
        totalFixed++;
      }
    }

    console.log(`Fixed ${totalFixed} URLs...`);
  }

  return totalFixed;
}

async function clearFailedEmbeddings(): Promise<number> {
  console.log('\n--- Step 2: Clearing ALL image embeddings to reprocess ---\n');

  // Count before clearing
  const { count: beforeCount } = await supabase
    .from('pinterest_pins')
    .select('id', { count: 'exact', head: true })
    .not('image_embedding', 'is', null);

  console.log(`Found ${beforeCount ?? 0} pins with image embeddings to clear...`);

  // Clear all image embeddings (set to NULL)
  const { error: clearError } = await supabase
    .from('pinterest_pins')
    .update({ image_embedding: null })
    .not('image_url', 'is', null);

  if (clearError) {
    console.error('Clear error:', clearError.message);
    return 0;
  }

  console.log('✓ All image embeddings cleared');
  return beforeCount ?? 0;
}

async function getStats(): Promise<void> {
  const [total, withOriginals, with474x, with236x, withEmbedding, nullEmbedding] = await Promise.all([
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).like('image_url', '%/originals/%'),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).like('image_url', '%/474x/%'),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).like('image_url', '%/236x/%'),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).not('image_embedding', 'is', null),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).is('image_embedding', null).not('image_url', 'is', null)
  ]);

  console.log('\nDatabase Stats:');
  console.log(`  Total pins: ${total.count}`);
  console.log(`  URLs with /originals/: ${withOriginals.count}`);
  console.log(`  URLs with /474x/: ${with474x.count}`);
  console.log(`  URLs with /236x/: ${with236x.count} (best)`);
  console.log(`  With image embedding: ${withEmbedding.count}`);
  console.log(`  Pending image embedding: ${nullEmbedding.count}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Fix Pinterest Image URLs');
  console.log('='.repeat(60));

  // Show before stats
  console.log('\n📊 BEFORE:');
  await getStats();

  // Step 1: Fix URLs
  const fixedUrls = await fixImageUrls();
  console.log(`\n✓ Fixed ${fixedUrls} image URLs`);

  // Step 2: Clear failed embeddings
  const cleared = await clearFailedEmbeddings();
  console.log(`✓ Cleared ${cleared} embeddings for reprocessing`);

  // Show after stats
  console.log('\n📊 AFTER:');
  await getStats();

  console.log('\n' + '='.repeat(60));
  console.log('Done! Now run: npm run embeddings:backfill');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
