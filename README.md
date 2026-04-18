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
- **AND logic** — multi-word Pinterest searches require all terms to match (prevents "web page" false positives)
- **Clean card titles** — Pinterest "This may contain:" prefix stripped; Pinterest domain hidden

### Collections
- Browse all items organized by folder (bookmarks) or board (Pinterest)
- Frosted glass panel with sidebar folder/board list and scrollable card grid
- Full pagination — fetches all rows (1000/page loop, no 40-item cap)
- **Alphabetical sort** — folders and boards sorted case-insensitively
- **Hidden boards** — specified boards excluded from search results, browse, and the board list
- **Mobile:** sticky Bookmarks/Pinterest tab switch; chips and cards scroll naturally below it

### Canvas
- Infinite drag-to-explore grid of your saved items
- Native `overflow: auto` scroll — compositor-thread smooth on touch/trackpad
- Mouse drag via direct `scrollLeft`/`scrollTop` manipulation + pointer-history inertia; window-level `pointermove`/`pointerup` listeners so drag continues if the pointer leaves the container
- **Click through drag** — distance threshold (>5px) suppresses the post-drag click so card links open correctly on desktop
- Infinite loop: 5×5 tiled grid with seamless scroll-event wrap
- **5 columns, 240×280px cards**, eager parallel fetch on mount (data ready before tab switch)
- Pinterest card titles truncated to one line; image fills remaining card height

### Sticky Notes
- Create color-coded notes on an infinite canvas (desktop: drag to reposition; mobile: 2-column masonry LIFO grid)
- 5 color themes with a color picker
- Double-click to edit, click backdrop to auto-save
- Image upload via paste or file picker (client-side compressed, stored as base64)
- Lightbox image viewer
- Synced to Supabase across devices; localStorage fallback when offline
- Positions persisted per note (`pos_x`, `pos_y`)
- **Archive** — deleted notes move to a trash bin (localStorage); restore or permanently delete from the Archive panel

### Save Tab
- **4th dock tab** — Plus (`+`) icon; opens a popover to navigate to Notes or Links
- **Header bar** — Notes and Saved Links panels each have a sticky title bar with the Archive button on the right
- **Link saving** — paste any URL to scrape metadata, generate embedding, and save to Supabase bookmarks (folder = OM)
- **Saved Links view** — list of all OM bookmarks with favicon, title, and delete button
- **Archive** — deleted links move to a trash bin (localStorage); restore (re-upserts to Supabase) or permanently delete
- Popover dock button for quick navigation between Notes and Links

### Chrome Extension
- Sync Chrome bookmarks and Pinterest pins to Supabase
- **Real-time delete sync** — removing a bookmark from Chrome instantly deletes it from Supabase via `onRemoved` listener
- **Startup reconciliation** — on every browser start or extension reload, compares Chrome bookmark URLs against Supabase and bulk-deletes orphaned rows; **OM-saved links (`folder = OM`) are excluded** so webapp-saved links are never wiped
- **Delete board** — remove all pins for a board from Supabase + local SQLite in one click
- Board list persists locally (SQLite) and syncs state with Supabase

### Visual
- **Liquid glass bottom dock** — dark-neutral glass pill with smooth sliding indicator between tabs
- Card design: `#f4f4f4` background, square aspect-ratio image, hover shadow (slow 500ms fade)
- Screenshot thumbnails via `screenshot.11ty.dev` (bookmarks); direct CDN image (Pinterest pins)
- Broken Pinterest image fallback to favicon placeholder
- **Crossfade video loop** — two stacked `<video>` elements; when the active video nears its end, the second video starts from t=0 and fades in over 1.5s (`ease-in-out`), hiding the loop cut

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
│  │                               Canvas / Save tab layout   │
│  ├── components/SearchResultCard  card with screenshot      │
│  ├── components/BrowseSection     collections grid          │
│  └── components/CanvasView        infinite drag canvas      │
├─────────────────────────────────────────────────────────────┤
│  Express API  →  Render                                     │
│  ├── server.ts                   REST endpoints             │
│  ├── redis.ts                    Upstash Redis cache layer  │
│  ├── supabase-search.ts          unified search + browse    │
│  ├── embeddings.ts               FastEmbed HTTP server      │
│  └── Python FastEmbed (port 3002) bge-small-en-v1.5 model  │
├─────────────────────────────────────────────────────────────┤
│  Upstash Redis                                              │
│  ├── search:{query}:{source}     5 min TTL                  │
│  ├── folders / boards            30 min TTL                 │
│  ├── notes:all                   5 min TTL                  │
│  └── om-links                    10 min TTL                 │
├─────────────────────────────────────────────────────────────┤
│  Supabase                                                   │
│  ├── bookmarks                   Chrome bookmarks + vectors │
│  ├── pinterest_pins              pins + vectors             │
│  ├── sticky_notes                notes with pos + image     │
│  └── pgvector HNSW indexes       fast similarity search     │
└─────────────────────────────────────────────────────────────┘
```

### Data flow — search
```
User types query
    ↓
Webapp GET /search → Render backend
    ↓
Check Upstash Redis cache (key: search:{query}:{source})
    ↓ cache miss
Backend generates embedding (FastEmbed Python server)
    ↓
Supabase: hybrid keyword + vector scoring
Hidden boards filtered from all results
    ↓
Results cached in Redis for 5 min
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
| Cache | Upstash Redis (search, notes, links, folders/boards) |
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
# Fill in:
#   SUPABASE_URL
#   SUPABASE_ANON_KEY
#   UPSTASH_REDIS_REST_URL
#   UPSTASH_REDIS_REST_TOKEN

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
Hidden boards are excluded from all results.

### `GET /browse?source=chrome&folder=<name>`
### `GET /browse?source=pinterest&board=<name>`
Returns all items in a folder or board (paginated internally, no cap).
Hidden boards excluded from Pinterest results.

### `GET /folders`
Returns all unique bookmark folder names. Cached in Redis for 30 min; invalidated when a new link is saved.

### `GET /boards`
Returns all unique Pinterest board names (hidden boards excluded). Cached in Redis for 30 min.

### `GET /notes`
Returns all sticky notes ordered newest-first. Cached in Redis for 5 min; invalidated on create/edit/delete.

### `POST /notes`
Upserts a sticky note. Invalidates `notes:all` cache on success.

### `DELETE /notes/:id`
Deletes a sticky note. Invalidates `notes:all` cache on success.

### `GET /om-links`
Returns all bookmarks saved via the webapp Save tab (folder = OM). Cached in Redis for 10 min; invalidated on save/delete.

### `POST /save-link`
Scrapes metadata, generates embedding, saves to Supabase. Invalidates `om-links` and `folders` cache.

### `DELETE /om-link?url=<url>`
Removes a saved link. Invalidates `om-links` cache.

### `POST /restore-link`
Re-upserts an archived link directly to Supabase (no scraping or embedding). Invalidates `om-links` cache.
```json
{ "url": "https://...", "title": "Page Title" }
```

### `DELETE /board?board_name=<name>`
Removes a board entry from local SQLite (caller responsible for Supabase pin deletion).

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

### Multi-term Pinterest search
Each term must match at least one of `title`, `description`, or `board_name` (AND between terms, OR across columns). Prevents vague single-column matches (e.g. "page" matching every pin description).

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

-- sticky_notes
CREATE TABLE sticky_notes (
  id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT,
  color_bg TEXT NOT NULL DEFAULT '#fde68a',
  color_text TEXT NOT NULL DEFAULT '#78350f',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  pos_x FLOAT,
  pos_y FLOAT,
  image_data TEXT
);
```

Both `bookmarks` and `pinterest_pins` have HNSW indexes on the `embedding` column for fast cosine similarity search.

---

## License

MIT
