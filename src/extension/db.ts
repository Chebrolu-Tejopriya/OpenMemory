/**
 * OpenMemory - Dexie.js Database Layer
 * Handles IndexedDB storage for bookmarks and indexing queue
 */

import Dexie, { Table } from 'dexie';

export interface IndexedBookmark {
  id?: number;
  url: string;
  title: string;
  folder: string | null;
  intent?: string;
  // Deep indexing fields
  extendedContent?: string;     // Concatenated metadata (max 500 chars)
  contentType?: string | null;  // 'blog' | 'article' | null
  indexedAt?: number;           // Timestamp when indexed
  indexStatus: 'pending' | 'indexed' | 'failed';
}

export interface IndexingQueueItem {
  id?: number;
  url: string;
  priority: number;    // Higher = process first
  createdAt: number;
}

export interface PinterestPin {
  id?: number;
  pinId: string;           // Unique Pinterest ID
  boardName: string;       // Board name for path display
  boardUrl: string;        // Board URL
  title: string;           // Pin title/alt-text
  description?: string;    // Pin description
  pinUrl: string;          // Original Pinterest URL
  sourceUrl?: string;      // External source link
  imageBlob?: Blob;        // WebP blob (persisted)
  originalImageUrl: string;// Original Pinterest CDN URL
  syncedAt: number;        // When synced
}

export interface Integration {
  id?: number;
  name: string;            // 'pinterest'
  username?: string;       // Pinterest username
  connected: boolean;
  lastSyncAt?: number;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncProgress?: number;   // 0-100
  totalPins?: number;
}

class OpenMemoryDB extends Dexie {
  bookmarks!: Table<IndexedBookmark, number>;
  queue!: Table<IndexingQueueItem, number>;
  pins!: Table<PinterestPin, number>;
  integrations!: Table<Integration, number>;

  constructor() {
    super('OpenMemoryDB');

    this.version(1).stores({
      // &url = unique index on url
      bookmarks: '++id, &url, title, folder, contentType, indexStatus',
      queue: '++id, url, priority'
    });

    this.version(2).stores({
      bookmarks: '++id, &url, title, folder, contentType, indexStatus',
      queue: '++id, url, priority',
      pins: '++id, &pinId, boardName, syncedAt',
      integrations: '++id, &name, connected'
    });
  }
}

export const db = new OpenMemoryDB();

// Helper functions
export async function getBookmarkByUrl(url: string): Promise<IndexedBookmark | undefined> {
  return db.bookmarks.where('url').equals(url).first();
}

export async function getPendingBookmarks(limit: number = 5): Promise<IndexedBookmark[]> {
  return db.bookmarks
    .where('indexStatus')
    .equals('pending')
    .limit(limit)
    .toArray();
}

export async function getIndexingStats(): Promise<{
  total: number;
  indexed: number;
  pending: number;
  failed: number;
}> {
  const [total, indexed, pending, failed] = await Promise.all([
    db.bookmarks.count(),
    db.bookmarks.where('indexStatus').equals('indexed').count(),
    db.bookmarks.where('indexStatus').equals('pending').count(),
    db.bookmarks.where('indexStatus').equals('failed').count()
  ]);

  return { total, indexed, pending, failed };
}

export async function updateBookmarkIndex(
  url: string,
  extendedContent: string,
  contentType: string | null
): Promise<void> {
  await db.bookmarks.where('url').equals(url).modify({
    extendedContent,
    contentType,
    indexedAt: Date.now(),
    indexStatus: 'indexed'
  });
}

export async function markBookmarkFailed(url: string): Promise<void> {
  await db.bookmarks.where('url').equals(url).modify({
    indexStatus: 'failed'
  });
}

export async function addToQueue(url: string, priority: number = 1): Promise<void> {
  await db.queue.add({
    url,
    priority,
    createdAt: Date.now()
  });
}

export async function removeFromQueue(id: number): Promise<void> {
  await db.queue.delete(id);
}

export async function getNextQueueBatch(limit: number = 5): Promise<IndexingQueueItem[]> {
  return db.queue
    .orderBy('priority')
    .reverse()
    .limit(limit)
    .toArray();
}
