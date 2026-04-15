import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { ingestItems } from './ingest.js';
import { search } from './search.js';
import { searchSupabase, getSupabaseFolders, getSupabaseBoards, browseSupabase } from './supabase-search.js';
import { getAllFolders, getPinterestBoards, getPinterestPinsCountByBoard, upsertPinterestBoard, upsertPinterestPins, getExistingPinterestPinUrls, deletePinterestBoard, PinterestPinRow, PinterestBoardRow } from './db.js';
import { StandardizedItem } from './types.js';
import { generateEmbeddings } from './embeddings.js';
import { scrapePageMetadata, buildEmbeddingText } from './scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Start the persistent Python embed server
function startEmbedServer() {
  const scriptPath = path.join(__dirname, '..', 'python', 'embed_server.py');
  const embedPort = process.env.EMBED_SERVER_PORT || '3002';

  const proc = spawn('python', [scriptPath], {
    env: { ...process.env, EMBED_SERVER_PORT: embedPort },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stdout.on('data', (d) => process.stdout.write(`[EmbedServer] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[EmbedServer] ${d}`));

  proc.on('close', (code) => {
    console.warn(`[EmbedServer] Exited with code ${code}. Restarting in 3s...`);
    setTimeout(startEmbedServer, 3000);
  });

  proc.on('error', (err) => {
    console.error('[EmbedServer] Failed to start:', err.message);
  });
}

startEmbedServer();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * GET /health
 * Health check endpoint for monitoring and keeping Render awake
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /ingest
 * Accepts standardized items from any source adapter.
 * Request body: { items: StandardizedItem[] }
 * Response: { count: number }
 */
app.post('/ingest', async (req, res) => {
  try {
    const { items } = req.body as { items: StandardizedItem[] };

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }

    const count = await ingestItems(items);
    res.json({ count });
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /folders
 * Get all unique folder paths from Supabase.
 * Response: { folders: string[] }
 */
app.get('/folders', async (req, res) => {
  try {
    const folders = await getSupabaseFolders();
    res.json({ folders });
  } catch (err) {
    console.error('Folders error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /boards
 * Get all unique Pinterest board names from Supabase.
 * Response: { boards: string[] }
 */
app.get('/boards', async (req, res) => {
  try {
    const boards = await getSupabaseBoards();
    res.json({ boards });
  } catch (err) {
    console.error('Boards error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /browse?source=chrome&folder=NAME&limit=500
 * GET /browse?source=pinterest&board=NAME&limit=500
 * Browse items in a folder/board. limit caps Supabase egress (default 500).
 */
app.get('/browse', async (req, res) => {
  try {
    const source = req.query.source as string;
    const folder = req.query.folder as string | undefined;
    const board = req.query.board as string | undefined;
    const maxItems = Math.min(parseInt(req.query.limit as string) || 500, 1000);

    if (source !== 'chrome' && source !== 'pinterest') {
      return res.status(400).json({ error: 'source must be chrome or pinterest' });
    }

    // folder/board is optional — omitting it returns ALL items for that source
    const folderOrBoard = (source === 'chrome' ? folder : board) ?? '';

    const result = await browseSupabase(source, folderOrBoard, maxItems);
    res.json(result);
  } catch (err) {
    console.error('Browse error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /embed
 * Body: { text: string }
 * Response: { embedding: number[] }
 */
app.post('/embed', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    const [embedding] = await generateEmbeddings([text]);
    res.json({ embedding });
  } catch (err) {
    console.error('Embed error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /resync-board
 * Body: { board_url: string, pins: PinterestPinRow[], board_name?: string, total_pins?: number }
 * Response: { added: number, total: number }
 */
app.post('/resync-board', async (req, res) => {
  try {
    const { board_url, pins, board_name, total_pins } = req.body as {
      board_url?: string;
      pins?: Array<Pick<PinterestPinRow, 'pin_url' | 'image' | 'title' | 'board_url' | 'created_at'> & { id?: string }>;
      board_name?: string;
      total_pins?: number;
    };

    if (!board_url || typeof board_url !== 'string') {
      return res.status(400).json({ error: 'board_url is required' });
    }

    if (!Array.isArray(pins)) {
      return res.status(400).json({ error: 'pins must be an array' });
    }

    const now = new Date().toISOString();
    const normalizedInput = pins
      .filter(pin => typeof pin.pin_url === 'string' && pin.pin_url.trim() !== '')
      .map(pin => ({
        ...pin,
        pin_url: pin.pin_url.trim()
      }));

    if (normalizedInput.length === 0) {
      return res.status(400).json({ error: 'pins must include pin_url' });
    }

    const uniqueByUrl = new Map<string, typeof normalizedInput[number]>();
    normalizedInput.forEach(pin => uniqueByUrl.set(pin.pin_url, pin));

    const uniquePins = Array.from(uniqueByUrl.values());
    const existingUrls = getExistingPinterestPinUrls(uniquePins.map(pin => pin.pin_url));
    const newPins = uniquePins.filter(pin => !existingUrls.has(pin.pin_url));

    const normalizedPins: PinterestPinRow[] = newPins.map((pin, index) => ({
      id: pin.id || `${board_url}#${pin.pin_url || index}`,
      pin_url: pin.pin_url,
      image: pin.image || null,
      title: pin.title || null,
      board_url: pin.board_url || board_url,
      created_at: pin.created_at || now
    }));

    const added = normalizedPins.length > 0 ? upsertPinterestPins(normalizedPins) : 0;
    const total = getPinterestPinsCountByBoard(board_url);

    const boardRow: PinterestBoardRow = {
      id: board_url,
      board_name: board_name || null,
      board_url,
      total_pins: typeof total_pins === 'number' ? total_pins : null,
      imported_pins: total,
      last_synced_at: new Date().toISOString()
    };

    upsertPinterestBoard(boardRow);

    res.json({ added, total });
  } catch (err) {
    console.error('Resync error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /pinterest-boards
 * Response: { boards: PinterestBoardRow[] }
 */
app.get('/pinterest-boards', (req, res) => {
  try {
    const boards = getPinterestBoards();
    res.json({ boards });
  } catch (err) {
    console.error('Pinterest boards error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /board?board_name=NAME
 * Remove a board entry from local SQLite so it disappears from the board list.
 * (Caller is responsible for deleting pins from Supabase separately.)
 */
app.delete('/board', (req, res) => {
  try {
    const boardName = req.query.board_name as string;
    if (!boardName) return res.status(400).json({ error: 'board_name is required' });
    deletePinterestBoard(boardName);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete board error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /run-embeddings
 * Response: { success: true }
 */
app.post('/run-embeddings', async (req, res) => {
  try {
    res.json({ success: true });
  } catch (err) {
    console.error('Embedding backfill error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * POST /save-link
 * Body: { url: string, folder?: string }
 * Scrapes metadata, generates a 384-dim embedding, and upserts to Supabase bookmarks.
 * Response: { success: true, title: string, url: string }
 */
app.post('/save-link', async (req, res) => {
  try {
    const { url, folder } = req.body as { url?: string; folder?: string };

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const cleanUrl = parsedUrl.toString();
    const folderName = folder?.trim() || 'Saved Links';

    // Scrape metadata
    const metadata = await scrapePageMetadata(cleanUrl);
    const title = metadata?.ogTitle || metadata?.pageTitle || parsedUrl.hostname;

    // Generate embedding
    const embeddingText = buildEmbeddingText({ title, folder: folderName, source: 'chrome', metadata });
    const [embedding] = await generateEmbeddings([embeddingText]);

    // Upsert to Supabase bookmarks (anon key has INSERT/UPDATE grants, RLS is off)
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ghfybenvdenuupiqgouf.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZnliZW52ZGVudXVwaXFnb3VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NTgwNDIsImV4cCI6MjA5MDIzNDA0Mn0._ADsqO0uFMEwNJ1lTKc3_0sBuuN3Jvxa3-naDmdYK1k';

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/bookmarks`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        url: cleanUrl,
        title,
        folder: folderName,
        ...(embedding ? { embedding: `[${embedding.join(',')}]` } : {}),
      }),
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('Supabase upsert error:', errText);
      return res.status(500).json({ error: 'Failed to save to Supabase' });
    }

    res.json({ success: true, title, url: cleanUrl });
  } catch (err) {
    console.error('Save link error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /search?q=QUERY&limit=20&offset=0&folder=PATH&source=chrome|pinterest
 * Semantic search using Supabase (cloud database with embeddings).
 * Response: { results: [...], total: number, hasMore: boolean }
 */
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 100;
    const source = req.query.source as string | undefined;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'q parameter is required' });
    }

    // Use Supabase search (has all embeddings already generated)
    const result = await searchSupabase(query, limit, source);
    res.json(result);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /search-local?q=QUERY&limit=20&offset=0&folder=PATH&source=chrome|pinterest
 * Local search using SQLite database (fallback).
 * Response: { results: [...], total: number, hasMore: boolean }
 */
app.get('/search-local', async (req, res) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const folder = req.query.folder as string | undefined;
    const source = req.query.source as string | undefined;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'q parameter is required' });
    }

    const result = await search(query, limit, offset, folder, source);
    res.json(result);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
