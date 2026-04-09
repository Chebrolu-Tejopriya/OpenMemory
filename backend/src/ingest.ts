import { StandardizedItem } from './types.js';
import { generateEmbeddings } from './embeddings.js';
import { insertItems, InsertItem } from './db.js';
import { classifyItemIntent } from './intent.js';
import { scrapePageMetadata, buildEmbeddingText, PageMetadata } from './scraper.js';

const BATCH_SIZE = 20; // Smaller batches for scraping
const SCRAPE_CONCURRENCY = 5; // Parallel scrape requests

/**
 * Scrapes metadata for multiple URLs with concurrency control.
 */
async function scrapeWithConcurrency(
  urls: string[],
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<(PageMetadata | null)[]> {
  const results: (PageMetadata | null)[] = new Array(urls.length).fill(null);
  let completed = 0;

  const queue = urls.map((url, index) => ({ url, index }));

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        results[item.index] = await scrapePageMetadata(item.url);
      } catch {
        results[item.index] = null;
      }

      completed++;
      if (onProgress) onProgress(completed, urls.length);
    }
  }

  // Start workers
  const workers = Array(Math.min(concurrency, urls.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

/**
 * Ingests standardized items from any source.
 * Scrapes page metadata, classifies intent, generates embeddings, and stores in database.
 */
export async function ingestItems(
  items: StandardizedItem[],
  onProgress?: (message: string) => void
): Promise<number> {
  if (items.length === 0) return 0;

  let totalIngested = 0;

  // Process in batches
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);

    if (onProgress) {
      onProgress(`Batch ${batchNum}/${totalBatches}: Scraping ${batch.length} pages...`);
    }

    // Scrape metadata for all URLs in batch
    const urls = batch.map(item => item.url);
    const metadataResults = await scrapeWithConcurrency(
      urls,
      SCRAPE_CONCURRENCY,
      (completed, total) => {
        if (onProgress) {
          onProgress(`Batch ${batchNum}/${totalBatches}: Scraped ${completed}/${total} pages`);
        }
      }
    );

    if (onProgress) {
      onProgress(`Batch ${batchNum}/${totalBatches}: Generating embeddings...`);
    }

    // Build rich embedding texts
    const texts = batch.map((item, idx) =>
      buildEmbeddingText({
        title: item.title,
        folder: item.folder,
        source: item.source,
        metadata: metadataResults[idx],
      })
    );

    // Generate embeddings for batch
    const embeddings = await generateEmbeddings(texts);

    // Prepare items for storage
    const itemsToStore: InsertItem[] = batch.map((item, idx) => ({
      source: item.source,
      title: item.title,
      url: item.url,
      folder: item.folder,
      intent: classifyItemIntent(item),
      metadata: metadataResults[idx] ? JSON.stringify(metadataResults[idx]) : null,
      embedding: embeddings[idx] ?? [],
      created_at: new Date(item.created_at).toISOString(),
    }));

    // Store in database
    const count = insertItems(itemsToStore);
    totalIngested += count;

    if (onProgress) {
      onProgress(`Batch ${batchNum}/${totalBatches}: Stored ${count} items`);
    }
  }

  return totalIngested;
}
