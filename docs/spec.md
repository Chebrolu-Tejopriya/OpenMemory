# OpenMemory — SYSTEM SPEC (SOURCE OF TRUTH)

This document defines EXACT behavior, architecture, and constraints.
Claude MUST follow this strictly. No assumptions. No deviations.

---

# 1. PRODUCT DEFINITION

OpenMemory is a personal inspiration memory system.

Users can:
- Save content (Chrome bookmarks, Pinterest pins) via the Chrome extension
- Search using natural language ("dark fintech dashboard")
- Filter by source, folder, or board
- Browse all saved items in a collections grid
- Explore visually in a drag-to-pan infinite canvas

---

# 2. CORE PRINCIPLES

1. **Search quality > everything**
2. **Keep architecture simple**
3. **Do NOT over-engineer**
4. **Do NOT introduce new systems unless specified**
5. **Follow existing schema strictly**
6. **Prefer editing over creating new files**

---

# 3. ARCHITECTURE OVERVIEW

## 3.1 System Components

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
│  src/app/page.tsx                single-viewport layout     │
│  src/components/                                            │
│  ├── SearchResultCard            card with screenshot       │
│  ├── SearchResults               3-col result grid          │
│  ├── BrowseSection               collections panel          │
│  └── CanvasView                  infinite drag canvas       │
├─────────────────────────────────────────────────────────────┤
│  Express API  →  Render free tier                           │
│  backend/src/                                               │
│  ├── server.ts                   REST endpoints             │
│  ├── supabase-search.ts          hybrid search + browse     │
│  └── embeddings.ts               FastEmbed Python bridge    │
│  Python FastEmbed server (port 3002)                        │
│  └── bge-small-en-v1.5 (384-dim text embeddings)           │
├─────────────────────────────────────────────────────────────┤
│  Supabase                                                   │
│  ├── bookmarks table             Chrome bookmarks + vectors │
│  ├── pinterest_pins table        Pinterest pins + vectors   │
│  └── pgvector HNSW indexes       cosine similarity search   │
└─────────────────────────────────────────────────────────────┘
```

## 3.2 Deployment

| Component | Platform | URL |
|---|---|---|
| Webapp | Vercel | `open-memory-nine.vercel.app` |
| Backend | Render free tier | (set in `NEXT_PUBLIC_BACKEND_URL`) |
| Database | Supabase | pgvector, free tier |

## 3.3 Architecture Rules

❌ NO serverless complexity  
❌ NO queues or background workers  
❌ NO multiple databases per user  
❌ NO per-user database instances  
✅ Single Supabase project for all data  
✅ Render backend handles both search API and embedding generation  
✅ Render free tier memory limit: ~512MB — keep FastEmbed model loaded once at startup

---

# 4. DATABASE SCHEMA (STRICT)

## 4.1 bookmarks

```sql
CREATE TABLE bookmarks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  folder TEXT,
  chrome_id TEXT,
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_bookmarks_url ON bookmarks(url);
CREATE INDEX idx_bookmarks_chrome_id ON bookmarks(chrome_id);
CREATE INDEX idx_bookmarks_folder ON bookmarks(folder);
CREATE INDEX idx_bookmarks_updated_at ON bookmarks(updated_at DESC);
CREATE INDEX idx_bookmarks_embedding ON bookmarks
  USING hnsw (embedding vector_cosine_ops);
```

## 4.2 pinterest_pins

```sql
CREATE TABLE pinterest_pins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pin_id TEXT NOT NULL UNIQUE,
  board_name TEXT NOT NULL,
  board_url TEXT,
  title TEXT,
  description TEXT,
  pin_url TEXT NOT NULL,
  image_url TEXT,
  embedding vector(384),
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pinterest_pins_pin_id ON pinterest_pins(pin_id);
CREATE INDEX idx_pinterest_pins_board_name ON pinterest_pins(board_name);
CREATE INDEX idx_pinterest_pins_synced_at ON pinterest_pins(synced_at);
CREATE INDEX idx_pinterest_pins_embedding ON pinterest_pins
  USING hnsw (embedding vector_cosine_ops);
```

## 4.3 Schema Rules

- URLs are UNIQUE — prevents duplicates
- Embeddings: **384 dimensions** (STRICT — never change)
- Embedding format: `Array<number>` (NOT Float32Array)
- `image_url` for Pinterest pins: direct CDN URL (e.g. `https://i.pinimg.com/...`)
- NEVER create per-user tables
- NEVER change embedding dimensions

---

# 5. EMBEDDING SYSTEM (CRITICAL)

## 5.1 Model

| Type | Model | Dimensions |
|---|---|---|
| Text | BAAI/bge-small-en-v1.5 (FastEmbed) | 384 |

## 5.2 Generation Pipeline

```
Extension / Webapp → POST /embed (Render backend)
    → Node.js calls Python FastEmbed HTTP server (port 3002)
    → 384-dim array returned
```

## 5.3 Rules (STRICT)

✅ MUST be `Array<number>`  
✅ MUST be exactly 384 dimensions  
✅ MUST use HTTP API calls (NOT in-browser ML)  
❌ NEVER use Float32Array directly  
❌ NEVER nest arrays  
❌ NEVER change dimensions  
❌ NEVER use @xenova/transformers in extension code  

## 5.4 LRU Embedding Cache (Backend)

- Cache size: 100 entries
- Key: normalized query string (lowercase, trimmed)
- Eviction: LRU (oldest timestamp)
- Hit: return cached embedding immediately

## 5.5 Smart Vector Skip

If keyword score ≥ 0.5 with ≥ 5 results → skip vector search entirely.  
Response time drops from ~5-8s to ~150-500ms for strong keyword queries.

---

# 6. SEARCH SYSTEM (CRITICAL)

## 6.1 Scoring Formula (MANDATORY)

```
FINAL_SCORE = 0.55 × keyword_score
            + 0.10 × vector_similarity
            + 0.15 × recency_score
            + 0.20 × source_boost
```

**Source ordering:** Bookmarks ALWAYS appear before Pinterest pins.  
Within each source: sorted by keyword score, then combined score.

## 6.2 Keyword Scoring (client-side, highest match wins)

| Score | Condition |
|---|---|
| 1.0 | Exact title match (case-insensitive) |
| 0.8 | Title contains full query |
| 0.75 | URL contains full query |
| 0.7 | All original query terms in title |
| 0.55 | >50% of query terms in title |
| 0.5 | URL contains any term (length > 2) |
| 0.4 | Folder/board contains query |
| 0.3 | Description contains query |
| 0.15 | Any term found anywhere |
| 0 | No match |

## 6.3 Query Expansion

Automatic synonym matching for design terms:
```
dashboard → admin, panel, analytics, metrics
ui        → interface, design, ux
fintech   → finance, banking, payment, crypto
mobile    → app, ios, android, responsive
landing   → homepage, hero, marketing
```

## 6.4 Recency Score

```sql
GREATEST(0, 1 - (EXTRACT(EPOCH FROM now() - created_at) / 2592000))
-- Decays to 0 over 30 days
```

## 6.5 Supabase RPC

```sql
search_all_items(
  query_embedding  vector(384),
  search_query     TEXT,
  use_vector_only  BOOLEAN DEFAULT false,
  match_count      INTEGER DEFAULT 30,
  filter_source    TEXT DEFAULT NULL,
  filter_folder    TEXT DEFAULT NULL,
  filter_board     TEXT DEFAULT NULL
)
```

All RPC calls and browse queries use `?select=` to **exclude the embedding column** from API responses — prevents Supabase egress from being exhausted by ~1.5KB per row of vector data.

## 6.6 Browse (Collections + Canvas)

```
GET /browse?source=chrome&folder=<name>
GET /browse?source=pinterest&board=<name>
```

- Paginates internally at 1000 rows/page — no item cap
- Returns full `SearchResult[]` with camelCase fields (`imageUrl`, `url`, `folder`)
- Does NOT include `embedding` column

---

# 7. API ENDPOINTS (Backend)

## Search
```
GET  /search?q=<query>
```
Hybrid keyword + vector search. Returns ranked `SearchResult[]`.

## Browse
```
GET  /browse?source=chrome&folder=<name>
GET  /browse?source=pinterest&board=<name>
```
All items in folder/board. No limit. Returns `{ results: SearchResult[], total: number }`.

## Metadata
```
GET  /folders       → { folders: string[] }
GET  /boards        → { boards: string[] }
```

## Embedding
```
POST /embed
Body:     { "text": "dark fintech dashboard" }
Response: { "embedding": [0.123, ...] }   // 384 floats
```

## SearchResult shape (API response)
```typescript
{
  id: string;
  title: string;
  url: string;
  folder: string | null;   // folder name (bookmarks) or board name (pins)
  source: "chrome" | "pinterest";
  imageUrl?: string;       // screenshot URL or Pinterest CDN URL
  score?: number;
}
```

---

# 8. WEBAPP UI (page.tsx)

## 8.1 Layout

Single-viewport, `h-screen overflow-hidden`. Three views toggled by bottom dock.

```
┌─────────────────────────────────────────────────────┐
│  Video background (leaf-animation.mp4, looping)     │
│                                                     │
│  ┌──── Active view (fills viewport) ───────────┐   │
│  │  Search  /  Collections  /  Canvas          │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌── Bottom dock (floating, center) ─────────┐     │
│  │  🔍  Search  │  ⊞  Collections  │  ⊹ Canvas│     │
│  └────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## 8.2 Search View

- Search bar with scope chip (@ folder, # board)
- `@` mention → folder dropdown to scope search
- `#` mention → Pinterest board dropdown
- Scope chip shown inside bar with X to clear
- Results: 3-column grid (`SearchResultCard`)

## 8.3 Collections View (BrowseSection)

- Left sidebar: folder list (bookmarks) or board list (Pinterest)
- Right: card grid of all items in selected folder/board
- Tab switch between Bookmarks and Pinterest at top
- Fully scrollable within viewport (`constrained` prop)

## 8.4 Canvas View (CanvasView)

- Infinite drag-to-explore grid
- **Scrolling**: native `overflow: auto` — compositor thread, smooth on touch/trackpad
- **Mouse drag**: direct `scrollLeft`/`scrollTop` manipulation in `pointermove`, no RAF
- **Inertia**: RAF with `Math.pow(0.998, dt_ms)` time-based friction after mouse release
- **Velocity**: computed from 80ms pointer history on release
- **Infinite loop**: 5×5 tiled grid; scroll event snaps back by one tile when near edge
- **Filter bar** (top-right): Bookmarks/Pinterest tab + folder/board dropdown
- **Cards**: 300×340px, 4 columns, gap 28px
- **Fetch**: bookmarks and pins fetched into separate arrays (each capped at 180) to prevent one source starving the other

---

# 9. COMPONENT REFERENCE

## SearchResultCard
- `#f4f4f4` background, square aspect-ratio image area
- Pinterest pins: red dot indicator, direct `image_url` thumbnail
- Bookmarks: `screenshot.11ty.dev` opengraph screenshot
- Hover: blur overlay + "Open" pill button
- Fallback: favicon + domain if screenshot/image fails

## BrowseSection
- Props: `source`, `folders`, `boards`, `constrained`
- Fetches via `GET /browse` with full pagination (1000/page loop)
- 3-column grid

## CanvasView
- Props: `folders: string[]`, `boards: string[]`, `active: boolean`
- Fetches lazily (only on first `active=true`)
- Separate fetch loops for bookmarks and pins (independent 180-item caps)
- `imageUrl` field: uses camelCase from API response — do NOT use `image_url`

---

# 10. PINTEREST INTEGRATION

## 10.1 Sync (Chrome Extension)

1. Detect Pinterest login via cookie check
2. Fetch board list via API interception (`api.pinterest.com`)
3. Deep scroll to load all pins per board
4. Extract: `pin_id`, `pin_url`, `image_url`, `title`, `description`, `board_name`
5. Batch upsert to Supabase → trigger embedding generation

## 10.2 image_url

- Stored as direct Pinterest CDN URL: `https://i.pinimg.com/736x/...`
- If null (old pins synced without image): card shows favicon placeholder
- Re-sync the board from the extension to populate missing `image_url`

## 10.3 Data Extraction Methods

1. **API Interception**: XHR/Fetch to `api.pinterest.com` (primary)
2. **DOM Scraping**: HTML parsing fallback
3. **Deep Scroll**: simulates scrolling for infinite boards

---

# 11. CHROME BOOKMARKS INTEGRATION

Real-time sync via Chrome extension alarms:

```typescript
chrome.bookmarks.onCreated  → upsertBookmark()
chrome.bookmarks.onRemoved  → deleteBookmark()
chrome.bookmarks.onChanged  → updateBookmark()
chrome.bookmarks.onMoved    → updateBookmark()
```

| Alarm | Interval | Purpose |
|---|---|---|
| `checkIndexing` | 2 min | Process metadata queue |
| `pinterestSync` | 1 hour | Sync Pinterest boards |
| `supabaseAutoSync` | 5 min | Auto-sync to Supabase |

---

# 12. PERFORMANCE TARGETS

| Metric | Target |
|---|---|
| Supabase vector search | < 500ms |
| Strong keyword match | ~150-500ms (vector skipped) |
| Cached query | ~100-200ms |
| Semantic search | ~5-8s (first call) |
| UI render | < 100ms |
| Canvas drag | Native compositor speed (touch/trackpad) |

---

# 13. WHAT CLAUDE MUST NEVER DO

❌ Change database schema unnecessarily  
❌ Introduce new services or dependencies  
❌ Modify embedding dimensions (always 384)  
❌ Use `image_url` (snake_case) when reading from the browse API — the response uses `imageUrl` (camelCase)  
❌ Call `screenshotUrl()` on Pinterest pin URLs — Pinterest blocks scrapers, returns junk  
❌ Add complexity without clear benefit  
❌ Create new files when editing existing ones works  
❌ Add features not explicitly requested  
❌ Use Float32Array for embeddings  
❌ Skip reading files before editing  

---

# 14. SUCCESS CRITERIA

```
✓ Fast      (< 500ms for keyword queries)
✓ Relevant  (semantic understanding for vague queries)
✓ Predictable (consistent, explainable ranking)
✓ Visual    (thumbnails, canvas, smooth animations)
```

---

# 15. FUTURE ENHANCEMENTS (NOT CURRENT PRIORITY)

- **Authentication** — Firebase/Supabase Auth, per-user data isolation
- **Public sharing** — read-only collection share links
- **Image search** — CLIP embeddings for image-to-image search
- **Zoom in canvas** — pinch-to-zoom with CSS scale transform
- **Re-sync from webapp** — trigger Pinterest board re-sync without the extension

---

# END OF SPEC
