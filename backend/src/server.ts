import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestItems } from './ingest.js';
import { search } from './search.js';
import { getAllFolders } from './db.js';
import { StandardizedItem } from './types.js';

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
