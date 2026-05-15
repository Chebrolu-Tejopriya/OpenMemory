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
import { getCache, setCache, invalidate } from './redis.js';

// Cache TTLs (seconds)
const TTL = {
  SEARCH: 600,    // 10 min — search results
  FOLDERS: 3600,  // 1 hr — folder list rarely changes
  BOARDS: 3600,   // 1 hr — board list rarely changes
  NOTES: 1800,    // 30 min — notes list (no image_data, safe to cache longer)
  OM_LINKS: 1800, // 30 min — saved links
  BROWSE: 7200,   // 2 hr — browse results (canvas fetches all bookmarks+pins)
};

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
    const cached = await getCache<string[]>('folders');
    if (cached) return res.json({ folders: cached });
    const folders = await getSupabaseFolders();
    await setCache('folders', folders, TTL.FOLDERS);
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
    const cached = await getCache<string[]>('boards');
    if (cached) return res.json({ boards: cached });
    const boards = await getSupabaseBoards();
    await setCache('boards', boards, TTL.BOARDS);
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

    const folderOrBoard = (source === 'chrome' ? folder : board) ?? '';
    const cacheKey = `browse:${source}:${folderOrBoard}`;
    const cached = await getCache<{ results: unknown[] }>(cacheKey);
    if (cached && cached.results?.length > 0) return res.json(cached);

    const result = await browseSupabase(source, folderOrBoard, maxItems);
    if (result.results.length > 0) await setCache(cacheKey, result, TTL.BROWSE);
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
    const folderName = folder?.trim() || 'OM';

    // Scrape metadata
    const metadata = await scrapePageMetadata(cleanUrl);
    const title = metadata?.ogTitle || metadata?.pageTitle || parsedUrl.hostname;

    // Generate embedding
    const embeddingText = buildEmbeddingText({ title, folder: folderName, source: 'chrome', metadata });
    const [embedding] = await generateEmbeddings([embeddingText]);

    // Upsert to Supabase bookmarks (anon key has INSERT/UPDATE grants, RLS is off)
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ghfybenvdenuupiqgouf.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZnliZW52ZGVudXVwaXFnb3VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NTgwNDIsImV4cCI6MjA5MDIzNDA0Mn0._ADsqO0uFMEwNJ1lTKc3_0sBuuN3Jvxa3-naDmdYK1k';

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/bookmarks?on_conflict=url`, {
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

    await invalidate('om-links', 'folders', 'browse:chrome:OM');
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

    const cacheKey = `search:${query.toLowerCase().trim()}:${source ?? 'all'}:${limit}`;
    const cached = await getCache<object>(cacheKey);
    if (cached) return res.json(cached);

    const result = await searchSupabase(query, limit, source);
    await setCache(cacheKey, result, TTL.SEARCH);
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

// ── Supabase helpers shared by note endpoints ──────────────────────────────
const SB_URL = process.env.SUPABASE_URL || 'https://ghfybenvdenuupiqgouf.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZnliZW52ZGVudXVwaXFnb3VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NTgwNDIsImV4cCI6MjA5MDIzNDA0Mn0._ADsqO0uFMEwNJ1lTKc3_0sBuuN3Jvxa3-naDmdYK1k';
const sbHeaders = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * GET /notes
 * Returns all sticky notes ordered newest-first.
 * Response: { notes: StickyNote[] }
 */
// image_data excluded from list — fetched on demand via GET /notes/:id
const NOTES_LIST_SELECT = 'id,title,body,color_bg,color_text,created_at,pos_x,pos_y,archived,todos';

app.get('/notes', async (req, res) => {
  try {
    const cached = await getCache<object[]>('notes:all');
    if (cached) return res.json({ notes: cached });
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?select=${NOTES_LIST_SELECT}&archived=is.false&order=created_at.desc`, { headers: sbHeaders });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const notes = await r.json();
    await setCache('notes:all', notes, TTL.NOTES);
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.get('/archived-notes', async (req, res) => {
  try {
    const cached = await getCache<object[]>('notes:archived');
    if (cached) return res.json({ notes: cached });
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?select=${NOTES_LIST_SELECT}&archived=is.true&order=created_at.desc`, { headers: sbHeaders });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const notes = await r.json();
    await setCache('notes:archived', notes, TTL.NOTES);
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /notes/:id
 * Returns a single note with full data including image_data (not cached — called on demand).
 */
app.get('/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: sbHeaders });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ note: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /notes
 * Body: { id, title, body, color: { bg, text }, createdAt }
 * Upserts a sticky note. Response: { success: true }
 */
app.post('/notes', async (req, res) => {
  try {
    const { id, title, body, color, createdAt, x, y, image, todos } = req.body as {
      id: string; title?: string; body?: string;
      color: { bg: string; text: string }; createdAt?: string;
      x?: number; y?: number; image?: string | null;
      todos?: string | null;
    };
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        id,
        title: title ?? '',
        body: body ?? '',
        color_bg: color?.bg ?? '#fde68a',
        color_text: color?.text ?? '#78350f',
        created_at: createdAt ?? new Date().toISOString(),
        ...(x !== undefined ? { pos_x: x } : {}),
        ...(y !== undefined ? { pos_y: y } : {}),
        ...(image !== undefined ? { image_data: image ?? null } : {}),
        ...(todos !== undefined ? { todos: todos ?? null } : {}),
      }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('notes:all');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /om-links
 * Returns all bookmarks saved under folder "OM" from the webapp Save tab.
 */
app.get('/om-links', async (req, res) => {
  try {
    const cached = await getCache<object[]>('om-links');
    if (cached) return res.json({ links: cached });
    const r = await fetch(
      `${SB_URL}/rest/v1/bookmarks?folder=eq.OM&archived=is.false&select=id,url,title,created_at&order=created_at.desc`,
      { headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const links = await r.json();
    await setCache('om-links', links, TTL.OM_LINKS);
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.get('/archived-links', async (req, res) => {
  try {
    const cached = await getCache<object[]>('om-links:archived');
    if (cached) return res.json({ links: cached });
    const r = await fetch(
      `${SB_URL}/rest/v1/bookmarks?folder=eq.OM&archived=is.true&select=id,url,title,created_at&order=created_at.desc`,
      { headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    const links = await r.json();
    await setCache('om-links:archived', links, TTL.OM_LINKS);
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * DELETE /om-link?url=URL
 * Archives an OM bookmark (sets archived=true).
 */
app.delete('/om-link', async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const r = await fetch(
      `${SB_URL}/rest/v1/bookmarks?url=eq.${encodeURIComponent(url)}&folder=eq.OM`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ archived: true }) }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('om-links', 'om-links:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /restore-link
 * Body: { url: string }
 * Restores an archived OM link (sets archived=false).
 */
app.post('/restore-link', async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: 'url is required' });
    const r = await fetch(
      `${SB_URL}/rest/v1/bookmarks?url=eq.${encodeURIComponent(url)}&folder=eq.OM`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ archived: false }) }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('om-links', 'om-links:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * DELETE /om-link/permanent?url=URL
 * Permanently deletes an archived OM link.
 */
app.delete('/om-link/permanent', async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const r = await fetch(
      `${SB_URL}/rest/v1/bookmarks?url=eq.${encodeURIComponent(url)}&folder=eq.OM`,
      { method: 'DELETE', headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('om-links:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * DELETE /notes/:id
 * Archives a sticky note (sets archived=true). Response: { success: true }
 */
app.delete('/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ archived: true }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('notes:all', 'notes:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /restore-note/:id
 * Restores an archived note (sets archived=false). Response: { success: true }
 */
app.post('/restore-note/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ archived: false }),
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('notes:all', 'notes:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * DELETE /notes/:id/permanent
 * Permanently deletes an archived note. Response: { success: true }
 */
app.delete('/notes/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(`${SB_URL}/rest/v1/sticky_notes?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: sbHeaders,
    });
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    await invalidate('notes:archived');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /telegram-webhook
 * Receives updates from Telegram Bot API.
 * - URL message → saved to OM bookmarks via /save-link logic
 * - Plain text → saved as a sticky note
 * Responds 200 immediately (Telegram requires fast ACK).
 */
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // ACK immediately so Telegram doesn't retry

  try {
    const { message } = req.body as {
      message?: {
        chat?: { id: number };
        text?: string;
        caption?: string;
        photo?: unknown[];
        entities?: Array<{ type: string; offset: number; length: number }>;
        caption_entities?: Array<{ type: string; offset: number; length: number }>;
      };
    };

    if (!message?.chat?.id) return;

    const chatId = message.chat.id;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) { console.error('TELEGRAM_BOT_TOKEN not set'); return; }

    const sendReply = async (msg: string) => {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
    };

    // Image with no text: reply unsupported
    if (message.photo && !message.caption) {
      await sendReply('🖼️ Images aren\'t supported. Send a link or some text.');
      return;
    }

    // Use caption as text if it's a photo with caption
    const rawText = message.photo ? message.caption! : message.text;
    const entities = message.photo ? (message.caption_entities ?? []) : (message.entities ?? []);

    if (!rawText) return;

    const text = rawText.trim();

    // Detect URLs: check Telegram entities or URL pattern
    const urlEntity = entities.find(e => e.type === 'url' || e.type === 'text_link');
    const urlPattern = /^https?:\/\/\S+$/i;
    const isUrl = !!urlEntity || urlPattern.test(text);

    if (isUrl) {
      // Extract URL from entity or use the full text
      const url = urlEntity
        ? text.slice(urlEntity.offset, urlEntity.offset + urlEntity.length)
        : text;

      let parsedUrl: URL;
      try { parsedUrl = new URL(url); } catch {
        await sendReply('❌ Invalid URL.');
        return;
      }

      const cleanUrl = parsedUrl.toString();
      const metadata = await scrapePageMetadata(cleanUrl);
      const title = metadata?.ogTitle || metadata?.pageTitle || parsedUrl.hostname;
      const folderName = 'OM';

      const embeddingText = buildEmbeddingText({ title, folder: folderName, source: 'chrome', metadata });
      const [embedding] = await generateEmbeddings([embeddingText]);

      const upsertRes = await fetch(`${SB_URL}/rest/v1/bookmarks?on_conflict=url`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          url: cleanUrl,
          title,
          folder: folderName,
          ...(embedding ? { embedding: `[${embedding.join(',')}]` } : {}),
        }),
      });

      if (upsertRes.ok) {
        await invalidate('om-links', 'folders', 'browse:chrome:OM');
        await sendReply(`✅ Link saved!\n${title}`);
      } else {
        console.error('Telegram save-link error:', await upsertRes.text());
        await sendReply('❌ Failed to save link. Try again.');
      }
    } else if (text.startsWith('/todo')) {
      // Save as todo note
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const items = lines.slice(1); // skip the /todo line

      if (items.length === 0) {
        await sendReply('Send items after /todo, e.g.:\n/todo\nBuy milk\nCall dentist');
        return;
      }

      // First item becomes title if there's more than one item, otherwise no title
      const title = items.length > 1 ? items[0] : '';
      const todoLines = items.length > 1 ? items.slice(1) : items;
      const todos = todoLines.map((t, i) => ({ id: `${Date.now()}-${i}`, text: t, done: false }));

      const noteId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const r = await fetch(`${SB_URL}/rest/v1/sticky_notes`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: noteId,
          title,
          body: '',
          todos: JSON.stringify(todos),
          color_bg: '#fde68a',
          color_text: '#78350f',
          created_at: new Date().toISOString(),
        }),
      });

      if (r.ok) {
        await invalidate('notes:all');
        await sendReply(`✅ Todo list saved! (${todos.length} item${todos.length === 1 ? '' : 's'})`);
      } else {
        console.error('Telegram save-todo error:', await r.text());
        await sendReply('❌ Failed to save todo. Try again.');
      }
    } else {
      // Save as sticky note
      const noteId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const r = await fetch(`${SB_URL}/rest/v1/sticky_notes`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          id: noteId,
          title: '',
          body: text,
          color_bg: '#fde68a',
          color_text: '#78350f',
          created_at: new Date().toISOString(),
        }),
      });

      if (r.ok) {
        await invalidate('notes:all');
        await sendReply('📝 Note saved!');
      } else {
        console.error('Telegram save-note error:', await r.text());
        await sendReply('❌ Failed to save note. Try again.');
      }
    }
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
