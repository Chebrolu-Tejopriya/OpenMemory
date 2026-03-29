import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestItems } from './ingest.js';
import { search } from './search.js';
import { getAllFolders, getPinterestBoards, getPinterestPinsCountByBoard, upsertPinterestBoard, upsertPinterestPins, getExistingPinterestPinUrls, PinterestPinRow, PinterestBoardRow } from './db.js';
import { StandardizedItem } from './types.js';
import { runEmbeddingBackfill } from '../../scripts/generateEmbeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
 * Get all unique folder paths for autocomplete.
 * Response: { folders: string[] }
 */
app.get('/folders', (req, res) => {
  try {
    const folders = getAllFolders();
    res.json({ folders });
  } catch (err) {
    console.error('Folders error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
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
 * POST /run-embeddings
 * Response: { success: true }
 */
app.post('/run-embeddings', async (req, res) => {
  try {
    await runEmbeddingBackfill();
    res.json({ success: true });
  } catch (err) {
    console.error('Embedding backfill error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /search?q=QUERY&limit=20&offset=0&folder=PATH
 * Semantic search across all stored items with pagination.
 * Response: { results: [...], total: number, hasMore: boolean }
 */
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const folder = req.query.folder as string | undefined;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'q parameter is required' });
    }

    const result = await search(query, limit, offset, folder);
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
