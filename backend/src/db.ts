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

  CREATE TABLE IF NOT EXISTS pinterest_pins (
    id TEXT PRIMARY KEY,
    pin_url TEXT NOT NULL UNIQUE,
    image TEXT,
    title TEXT,
    board_url TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pinterest_boards (
    id TEXT PRIMARY KEY,
    board_name TEXT,
    board_url TEXT NOT NULL UNIQUE,
    total_pins INTEGER,
    imported_pins INTEGER,
    last_synced_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pinterest_pins_board_url ON pinterest_pins(board_url);
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

export interface PinterestPinRow {
  id: string;
  pin_url: string;
  image: string | null;
  title: string | null;
  board_url: string | null;
  created_at: string | null;
}

export interface PinterestBoardRow {
  id: string;
  board_name: string | null;
  board_url: string;
  total_pins: number | null;
  imported_pins: number | null;
  last_synced_at: string | null;
}

const insertPinterestPinStmt = db.prepare(`
  INSERT INTO pinterest_pins (id, pin_url, image, title, board_url, created_at)
  VALUES (@id, @pin_url, @image, @title, @board_url, @created_at)
  ON CONFLICT(pin_url) DO UPDATE SET
    image = COALESCE(@image, image),
    title = COALESCE(@title, title),
    board_url = COALESCE(@board_url, board_url)
`);

const insertPinterestBoardStmt = db.prepare(`
  INSERT INTO pinterest_boards (id, board_name, board_url, total_pins, imported_pins, last_synced_at)
  VALUES (@id, @board_name, @board_url, @total_pins, @imported_pins, @last_synced_at)
  ON CONFLICT(board_url) DO UPDATE SET
    board_name = COALESCE(@board_name, board_name),
    total_pins = COALESCE(@total_pins, total_pins),
    imported_pins = COALESCE(@imported_pins, imported_pins),
    last_synced_at = COALESCE(@last_synced_at, last_synced_at)
`);

const getBoardPinsCountStmt = db.prepare(`
  SELECT COUNT(*) as count FROM pinterest_pins WHERE board_url = ?
`);

const getBoardsStmt = db.prepare(`
  SELECT * FROM pinterest_boards ORDER BY last_synced_at DESC
`);

const deleteBoardStmt = db.prepare(`
  DELETE FROM pinterest_boards WHERE board_name = ?
`);

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

export function upsertPinterestPins(pins: PinterestPinRow[]): number {
  const now = new Date().toISOString();
  const insertMany = db.transaction((pins: PinterestPinRow[]) => {
    let count = 0;
    for (const pin of pins) {
      insertPinterestPinStmt.run({
        id: pin.id,
        pin_url: pin.pin_url,
        image: pin.image || null,
        title: pin.title || null,
        board_url: pin.board_url || null,
        created_at: pin.created_at || now
      });
      count++;
    }
    return count;
  });
  return insertMany(pins);
}

export function getExistingPinterestPinUrls(pinUrls: string[]): Set<string> {
  const existing = new Set<string>();
  const CHUNK_SIZE = 200;

  for (let i = 0; i < pinUrls.length; i += CHUNK_SIZE) {
    const chunk = pinUrls.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT pin_url FROM pinterest_pins WHERE pin_url IN (${placeholders})`);
    const rows = stmt.all(...chunk) as Array<{ pin_url: string }>;
    rows.forEach(row => existing.add(row.pin_url));
  }

  return existing;
}

export function getPinterestPinsCountByBoard(boardUrl: string): number {
  const row = getBoardPinsCountStmt.get(boardUrl) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function upsertPinterestBoard(board: PinterestBoardRow): void {
  insertPinterestBoardStmt.run({
    id: board.id,
    board_name: board.board_name,
    board_url: board.board_url,
    total_pins: board.total_pins,
    imported_pins: board.imported_pins,
    last_synced_at: board.last_synced_at
  });
}

export function getPinterestBoards(): PinterestBoardRow[] {
  return getBoardsStmt.all() as PinterestBoardRow[];
}

export function deletePinterestBoard(boardName: string): void {
  deleteBoardStmt.run(boardName);
}

export { db };
