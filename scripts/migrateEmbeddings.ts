/**
 * Embedding Migration Script
 *
 * Clears all existing embeddings and regenerates them using:
 * - FastEmbed BGE-small-en-v1.5 for text (384 dim)
 * - CLIP ViT-B/32 for images (512 dim)
 *
 * Run: npx tsx scripts/migrateEmbeddings.ts
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

async function clearAllEmbeddings(): Promise<void> {
  console.log('Clearing all existing embeddings...');

  // Clear bookmark embeddings
  const { error: bookmarkError } = await supabase
    .from('bookmarks')
    .update({ embedding: null })
    .not('embedding', 'is', null);

  if (bookmarkError) {
    console.error('Failed to clear bookmark embeddings:', bookmarkError.message);
  } else {
    console.log('✓ Cleared bookmark embeddings');
  }

  // Clear Pinterest text embeddings
  const { error: pinterestTextError } = await supabase
    .from('pinterest_pins')
    .update({ embedding: null })
    .not('embedding', 'is', null);

  if (pinterestTextError) {
    console.error('Failed to clear Pinterest text embeddings:', pinterestTextError.message);
  } else {
    console.log('✓ Cleared Pinterest text embeddings');
  }

  // Clear Pinterest image embeddings (if column exists)
  try {
    const { error: pinterestImageError } = await supabase
      .from('pinterest_pins')
      .update({ image_embedding: null })
      .not('image_embedding', 'is', null);

    if (pinterestImageError) {
      // Column might not exist yet
      console.log('Note: image_embedding column may not exist yet (run migration 004 first)');
    } else {
      console.log('✓ Cleared Pinterest image embeddings');
    }
  } catch {
    console.log('Note: image_embedding column not found (run migration 004 first)');
  }
}

async function getCounts(): Promise<{
  bookmarks: number;
  pinterestPins: number;
  bookmarksWithEmbedding: number;
  pinterestWithTextEmbedding: number;
  pinterestWithImageEmbedding: number;
}> {
  const [bookmarks, pinterestPins, bookmarksEmbed, pinterestTextEmbed] = await Promise.all([
    supabase.from('bookmarks').select('id', { count: 'exact', head: true }),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }),
    supabase.from('bookmarks').select('id', { count: 'exact', head: true }).not('embedding', 'is', null),
    supabase.from('pinterest_pins').select('id', { count: 'exact', head: true }).not('embedding', 'is', null)
  ]);

  // image_embedding column may not exist yet
  let pinterestImageCount = 0;
  try {
    const pinterestImageEmbed = await supabase
      .from('pinterest_pins')
      .select('id', { count: 'exact', head: true })
      .not('image_embedding', 'is', null);
    pinterestImageCount = pinterestImageEmbed.count ?? 0;
  } catch {
    // Column doesn't exist yet
  }

  return {
    bookmarks: bookmarks.count ?? 0,
    pinterestPins: pinterestPins.count ?? 0,
    bookmarksWithEmbedding: bookmarksEmbed.count ?? 0,
    pinterestWithTextEmbedding: pinterestTextEmbed.count ?? 0,
    pinterestWithImageEmbedding: pinterestImageCount
  };
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Embedding Migration: MiniLM → FastEmbed BGE + CLIP');
  console.log('='.repeat(60));

  // Show current counts
  console.log('\nCurrent database state:');
  const beforeCounts = await getCounts();
  console.log(`  Bookmarks: ${beforeCounts.bookmarks} total, ${beforeCounts.bookmarksWithEmbedding} with embedding`);
  console.log(`  Pinterest: ${beforeCounts.pinterestPins} total`);
  console.log(`    - Text embeddings: ${beforeCounts.pinterestWithTextEmbedding}`);
  console.log(`    - Image embeddings: ${beforeCounts.pinterestWithImageEmbedding}`);

  // Confirm before proceeding
  console.log('\n⚠️  This will CLEAR all existing embeddings!');
  console.log('After clearing, run: npm run embeddings:backfill');

  // Clear embeddings
  console.log('\n--- Clearing embeddings ---');
  await clearAllEmbeddings();

  // Show updated counts
  console.log('\nAfter clearing:');
  const afterCounts = await getCounts();
  console.log(`  Bookmarks with embedding: ${afterCounts.bookmarksWithEmbedding}`);
  console.log(`  Pinterest text embeddings: ${afterCounts.pinterestWithTextEmbedding}`);
  console.log(`  Pinterest image embeddings: ${afterCounts.pinterestWithImageEmbedding}`);

  console.log('\n' + '='.repeat(60));
  console.log('Migration Step 1 Complete!');
  console.log('='.repeat(60));
  console.log('\nNext steps:');
  console.log('1. Run the database migration: supabase db push (or apply 004_add_image_embeddings.sql)');
  console.log('2. Generate new embeddings: npm run embeddings:backfill');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
