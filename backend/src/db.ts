import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data.db');

const db: DatabaseType = new Database(DB_PATH);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    folder TEXT,
    intent TEXT NOT NULL DEFAULT 'reference',
    metadata TEXT,
    embedding TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
  CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
  CREATE INDEX IF NOT EXISTS idx_items_intent ON items(intent);
`);

export interface InsertItem {
  source: string;
  title: string;
  url: string;
  folder: string | null;
  intent: string;
  metadata: string | null;
  embedding: number[];
  created_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO items (source, title, url, folder, intent, metadata, embedding, created_at, ingested_at)
  VALUES (@source, @title, @url, @folder, @intent, @metadata, @embedding, @created_at, @ingested_at)
  ON CONFLICT(url) DO UPDATE SET
    source = @source,
    title = @title,
    folder = @folder,
    intent = @intent,
    metadata = @metadata,
    embedding = @embedding,
    ingested_at = @ingested_at
`);

const getAllStmt = db.prepare(`SELECT * FROM items`);
const getFoldersStmt = db.prepare(`SELECT DISTINCT folder FROM items WHERE folder IS NOT NULL ORDER BY folder`);

export function insertItems(items: InsertItem[]): number {
  const now = new Date().toISOString();
  const insertMany = db.transaction((items: InsertItem[]) => {
    let count = 0;
    for (const item of items) {
      insertStmt.run({
        source: item.source,
        title: item.title,
        url: item.url,
        folder: item.folder,
        intent: item.intent,
        metadata: item.metadata,
        embedding: JSON.stringify(item.embedding),
        created_at: item.created_at,
        ingested_at: now,
      });
      count++;
    }
    return count;
  });
  return insertMany(items);
}

export function getAllItems() {
  const rows = getAllStmt.all() as Array<{
    id: number;
    source: string;
    title: string;
    url: string;
    folder: string | null;
    intent: string;
    metadata: string | null;
    embedding: string;
    created_at: string;
    ingested_at: string;
  }>;

  return rows.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    embedding: JSON.parse(row.embedding) as number[],
  }));
}

export function getAllFolders(): string[] {
  const rows = getFoldersStmt.all() as Array<{ folder: string }>;
  return rows.map(r => r.folder);
}

export { db };
