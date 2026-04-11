# OpenMemory

A personal inspiration memory system — search your Chrome bookmarks and Pinterest pins using natural language and browse them visually in a drag-to-explore infinite canvas.

**Live:** [open-memory-nine.vercel.app](https://open-memory-nine.vercel.app)

---

## Features

### Search
- **Hybrid search** — keyword scoring + Supabase pgvector semantic search
- **@ mention** — type `@` in the search bar to scope search to a bookmark folder
- **# mention** — type `#` to scope search to a Pinterest board
- **Scope chip** — selected folder/board shown inside the bar with one-click clear
- **LRU embedding cache** — repeated queries return instantly; smart skip if keyword score is strong enough

### Collections
- Browse all items organized by folder (bookmarks) or board (Pinterest)
- Frosted glass panel with sidebar folder/board list and scrollable card grid
- Full pagination — fetches all rows (1000/page loop, no 40-item cap)

### Canvas
- Infinite drag-to-explore grid of your saved items
- Native `overflow: auto` scroll — compositor-thread smooth on touch/trackpad
- Mouse drag via direct `scrollLeft`/`scrollTop` manipulation + pointer-history inertia
- Infinite loop: 5×5 tiled grid with seamless scroll-event wrap
- Top-right filter bar: Bookmarks / Pinterest tab switch + folder/board dropdown

### Visual
- Card design: `#f4f4f4` background, square aspect-ratio image, hover blur + "Open" pill
- Screenshot thumbnails via `screenshot.11ty.dev` (bookmarks); direct CDN image (Pinterest pins)
- Animated video background (`leaf-animation.mp4`)
- Bottom-center floating dock: Search · Collections · Canvas icons

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                             │
│  ├── sidepanel.html              UI                         │
│  ├── background.ts               service worker, alarms     │
│  ├── search.ts                   hybrid search logic        │
│  ├── supabase.ts                 cloud CRUD + embeddings    │
│  ├── pinterest.ts                Pinterest content script   │
│  └── db.ts                       IndexedDB via Dexie.js     │
├─────────────────────────────────────────────────────────────┤
│  Next.js Webapp  →  Vercel (open-memory-nine.vercel.app)    │
│  ├── app/page.tsx                Search / Collections /     │
│  │                               Canvas tab layout          │
│  ├── components/SearchResultCard  card with screenshot      │
│  ├── components/BrowseSection     collections grid          │
│  └── components/CanvasView        infinite drag canvas      │
├─────────────────────────────────────────────────────────────┤
│  Express API  →  Render free tier                           │
│  ├── server.ts                   REST endpoints             │
│  ├── supabase-search.ts          unified search + browse    │
│  ├── embeddings.ts               FastEmbed HTTP server      │
│  └── Python FastEmbed (port 3002) bge-small-en-v1.5 model  │
├─────────────────────────────────────────────────────────────┤
│  Supabase                                                   │
│  ├── bookmarks                   Chrome bookmarks + vectors │
│  ├── pinterest_pins              pins + vectors             │
│  └── pgvector HNSW indexes       fast similarity search     │
└─────────────────────────────────────────────────────────────┘
```

### Data flow — search
```
User types query
    ↓
Webapp POST /search → Render backend
    ↓
Backend generates embedding (FastEmbed Python server)
    ↓
Supabase RPC: hybrid keyword + vector scoring
    ↓
Results ranked by: 0.55×keyword + 0.10×semantic + 0.15×recency + 0.20×source
    ↓
3-column card grid with screenshot thumbnails
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| Webapp | Next.js 14, React, Tailwind CSS |
| Hosting | Vercel (webapp), Render (backend) |
| Database | Supabase (PostgreSQL + pgvector) |
| Embeddings | FastEmbed `bge-small-en-v1.5` (384-dim) |
| Extension | TypeScript, Manifest V3, Dexie.js |
| Icons | lucide-react |

---

## Local Development

### Prerequisites
- Node.js 18+
- Python 3.9+ (for the FastEmbed embedding server)
- Chrome browser

### 1. Clone
```bash
git clone https://github.com/Chebrolu-Tejopriya/OpenMemory.git
cd OpenMemory
```

### 2. Backend
```bash
cd backend
npm install

# Install Python dependencies for FastEmbed
cd python
pip install -r requirements.txt
cd ..

# Create .env
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_ANON_KEY

npm run dev   # starts on port 3001
```

### 3. Webapp
```bash
cd webapp
npm install

# Create .env.local
echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:3001" > .env.local

npm run dev   # starts on port 3000
```

### 4. Extension
```bash
# Root folder
npm install
npm run build   # outputs to dist/
```
Load `dist/` as an unpacked extension in `chrome://extensions/`.

---

## API Reference

All endpoints served by the Express backend (Render in prod, `localhost:3001` locally).

### `GET /search?q=<query>`
Hybrid keyword + vector search across bookmarks and Pinterest pins.

### `GET /browse?source=chrome&folder=<name>`
### `GET /browse?source=pinterest&board=<name>`
Returns all items in a folder or board (paginated internally, no cap).

### `GET /folders`
Returns all unique bookmark folder names.

### `GET /boards`
Returns all unique Pinterest board names.

### `POST /embed`
```json
{ "text": "dark fintech dashboard" }
→ { "embedding": [0.123, ...] }   // 384 floats
```

---

## Search Algorithm

### Scoring formula
```
score = 0.55 × keyword_score
      + 0.10 × semantic_similarity
      + 0.15 × recency_score
      + 0.20 × source_boost
```

Bookmarks always ranked before Pinterest pins within the same relevance tier.

### Keyword scoring (highest match wins)
| Score | Condition |
|---|---|
| 1.0 | Exact title match |
| 0.8 | Title contains full query |
| 0.75 | URL contains full query |
| 0.7 | All query terms in title |
| 0.55 | >50% of terms in title |
| 0.5 | URL contains any term |
| 0.4 | Folder/board contains query |
| 0.3 | Description contains query |
| 0.15 | Any term found anywhere |

### Smart vector skip
If keyword score ≥ 0.5 with 5+ results, vector search is skipped entirely — reduces latency to ~150ms for common queries like `"figma"` or `"dashboard"`.

### Supabase egress optimization
All RPC calls and browse queries use `?select=` to exclude the `embedding` vector column from API responses (~1.5 KB saved per row).

---

## Supabase Schema

```sql
-- bookmarks
CREATE TABLE bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  folder TEXT,
  chrome_id TEXT,
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- pinterest_pins
CREATE TABLE pinterest_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id TEXT UNIQUE,
  board_name TEXT,
  pin_url TEXT UNIQUE NOT NULL,
  image_url TEXT,
  title TEXT,
  description TEXT,
  embedding vector(384),
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Both tables have HNSW indexes on the `embedding` column for fast cosine similarity search.

---

## License

MIT
