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

## 6.5 Pinterest Text Search

Direct PostgREST GET query (NOT an RPC). For each query term, requires it to appear in `title` OR `description` OR `board_name`:

```
Single term:  ?or=(title.ilike.*x*,description.ilike.*x*,board_name.ilike.*x*)
Multi-term:   ?and=(or(title.ilike.*x*,...),or(title.ilike.*y*,...))
```

AND between terms prevents vague matches (e.g. "page" in every pin description).

## 6.6 Hidden Boards

Certain boards are excluded from ALL surfaces (search results, board list, browse/canvas):

```typescript
const HIDDEN_BOARDS = new Set([
  'book art drawings',
  'your profile',
  'test board',
]);
```

Filter is case-insensitive. Applied in `getSupabaseBoards()`, `browseSupabase()`, and `searchSupabase()` (both text and vector result paths).

## 6.7 Browse (Collections + Canvas)

```
GET /browse?source=chrome&folder=<name>
GET /browse?source=pinterest&board=<name>
```

- Paginates internally at 1000 rows/page — no item cap
- Returns full `SearchResult[]` with camelCase fields (`imageUrl`, `url`, `folder`)
- Does NOT include `embedding` column
- Hidden boards excluded from Pinterest results

---

# 7. API ENDPOINTS (Backend)

## Search
```
GET  /search?q=<query>
```
Hybrid keyword + vector search. Hidden boards excluded. Returns ranked `SearchResult[]`.

## Browse
```
GET  /browse?source=chrome&folder=<name>
GET  /browse?source=pinterest&board=<name>
```
All items in folder/board. No limit. Returns `{ results: SearchResult[], total: number }`.

## Metadata
```
GET  /folders       → { folders: string[] }
GET  /boards        → { boards: string[] }   // hidden boards excluded
```

## Board management (extension → backend)
```
POST   /resync-board    Body: { board_url, pins[], board_name?, total_pins? }
GET    /pinterest-boards → { boards: PinterestBoardRow[] }
DELETE /board?board_name=<name>   // removes from local SQLite
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

**Video background crossfade loop**: Two stacked `<video>` elements (refs `videoRef` / `videoBRef`). A `timeupdate` listener monitors the active video; when `duration - currentTime ≤ CROSSFADE_SECS (1.5)`, the inactive video seeks to `t=0`, starts playing, and both videos transition opacity simultaneously (`ease-in-out 1.5s`). A `crossfadingRef` flag prevents re-entrancy. The background container is `bg-[#ebfdff]`.

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

## 8.2 Bottom Dock

Liquid glass pill, dark-neutral base (visible on any background):
- `background: linear-gradient(160deg, rgba(10,10,10,0.35) 0%, rgba(10,10,10,0.28) 100%)`
- `backdropFilter: blur(40px) saturate(160%)`
- Multi-layer `inset box-shadow` for specular highlights
- Absolutely-positioned sliding glass indicator that transitions `left` using `cubic-bezier(0.65, 0, 0.35, 1)` (no bounce)
- Button size: 44×44px, padding: 6px, gap: 4px, border-radius: 22px

## 8.3 Search View

- Search bar with scope chip (@ folder, # board)
- `@` mention → folder dropdown to scope search
- `#` mention → Pinterest board dropdown
- Scope chip shown inside bar with X to clear
- Results: 3-column grid (`SearchResultCard`)
- Search bar container: `z-30 pointer-events-none`; form, dropdown, chips: `pointer-events-auto`

## 8.4 Collections View (BrowseSection)

**Desktop (≥ md):**
- Left sidebar: folder/board list, sticky within viewport
- Right: card grid of all items in selected folder/board
- Tab switch (Bookmarks/Pinterest) at top of sidebar

**Mobile (< md):**
- Tab switch: `sticky top-0 z-10` with `bg-[#ebfdff]/95 backdrop-blur-sm` — stays visible while scrolling
- Folder/board chips: horizontal scroll row, scrolls away naturally
- Cards: 2-column grid below chips, `pb-24` for dock clearance
- Top padding: `pt-4` (not `pt-14`) — no blank space above Collections header

**Both:**
- Folders and boards sorted **case-insensitively alphabetically** (`.sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()))`)
- First item in sorted list auto-selected on tab switch
- Full pagination (1000/page loop)

## 8.5 Canvas View (CanvasView)

- Infinite drag-to-explore grid
- **Scrolling**: native `overflow: auto` — compositor thread, smooth on touch/trackpad
- **Mouse drag**: direct `scrollLeft`/`scrollTop` manipulation in `pointermove`, no RAF
- **Drag listeners**: `pointermove`/`pointerup` attached to `window` on drag start (not the container element) so drag continues when pointer leaves the canvas boundary
- **No `setPointerCapture`**: pointer capture is intentionally NOT used — it routes events away from `<a>` elements and breaks card link navigation on desktop
- **Click suppression**: if drag distance > 5px, a one-shot `window.addEventListener("click", suppress, { capture: true })` swallows the post-drag click to prevent accidental link opens
- **Inertia**: RAF with `Math.pow(0.998, dt_ms)` time-based friction after mouse release
- **Velocity**: computed from 80ms pointer history on release
- **Infinite loop**: 5×5 tiled grid; scroll event snaps back by one tile when near edge
- **No filter bar** — source is selected via tab switch only; no folder/board dropdown
- **Cards**: 240×280px, **5 columns**, gap 24px, title truncated to single line, image fills remaining height (`flex-1`)
- **Fetch**: eager parallel fetch on mount (`Promise.allSettled`), not gated by `active` prop; separate arrays per source capped at 180 items each

---

# 9. COMPONENT REFERENCE

## SearchResultCard
- `#f4f4f4` background, square aspect-ratio image area
- Pinterest pins: red dot indicator, direct `image_url` thumbnail
- Bookmarks: `screenshot.11ty.dev` opengraph screenshot
- Hover: blur overlay + "Open" pill button; soft shadow fades in over 500ms
- **Pinterest title cleanup**: strip `"This may contain:?"` prefix (case-insensitive)
- **Pinterest domain hidden**: footer domain not shown for Pinterest cards
- **Broken image fallback**: `onError` state → falls back to favicon placeholder

## BrowseSection
- Props: `folders`, `boards`, `constrained`
- Fetches via `GET /browse` with full pagination (1000/page loop)
- Alphabetical sort applied client-side (case-insensitive)
- Desktop: 3-column grid; Mobile: 2-column grid
- Mobile: sticky tab switch, natural chip/card scroll

## CanvasView
- Props: `folders: string[]`, `boards: string[]`, `active: boolean`
- Fetches eagerly on mount (not gated by `active`)
- Separate fetch loops for bookmarks and pins (independent 180-item caps)
- `imageUrl` field: uses camelCase from API response — do NOT use `image_url`
- Pinterest titles cleaned (strip "This may contain:" prefix)
- Pinterest domain hidden from card footer

---

# 10. PINTEREST INTEGRATION

## 10.1 Sync (Chrome Extension)

1. Detect Pinterest login via cookie check
2. Fetch board list via API interception (`api.pinterest.com`)
3. Deep scroll to load all pins per board
4. Extract: `pin_id`, `pin_url`, `image_url`, `title`, `description`, `board_name`
5. Batch upsert to Supabase → trigger embedding generation

## 10.2 Board Management (Extension)

- **Resync**: POST `/resync-board` with new pins; deduplicates against existing `pin_url`s
- **Delete**: 
  1. DELETE `pinterest_pins?board_name=eq.<name>` on Supabase
  2. DELETE `/board?board_name=<name>` on backend (removes SQLite entry)
  3. Update board list UI

## 10.3 image_url

- Stored as direct Pinterest CDN URL: `https://i.pinimg.com/736x/...`
- If null (old pins synced without image): card shows favicon placeholder
- Re-sync the board from the extension to populate missing `image_url`

## 10.4 Data Extraction Methods

1. **API Interception**: XHR/Fetch to `api.pinterest.com` (primary)
2. **DOM Scraping**: HTML parsing fallback
3. **Deep Scroll**: simulates scrolling for infinite boards

---

# 11. CHROME BOOKMARKS INTEGRATION

## 11.1 Real-time sync via Chrome extension events

```typescript
chrome.bookmarks.onCreated  → upsertBookmark()
chrome.bookmarks.onRemoved  → deleteBookmark() from Dexie + Supabase
chrome.bookmarks.onChanged  → updateBookmark()
chrome.bookmarks.onMoved    → updateBookmark()
```

## 11.2 Startup Reconciliation

`onRemoved` is not always reliable — the Manifest V3 service worker can be dormant when a bookmark is deleted, causing the event to be missed. Folder deletions also only fire one `onRemoved` for the folder, not for each child.

On every `onInstalled` and `onStartup`, `reconcileDeletedBookmarks()` runs after an 8-second delay:

1. Fetch all URLs from Supabase `bookmarks` table (`select=url` only, paginated at 1000/page)
2. Fetch all current Chrome bookmark URLs via `chrome.bookmarks.getTree()`
3. Diff: any URL in Supabase not present in Chrome is an orphan
4. Delete each orphan via `deleteBookmark(url, 'url')`

This guarantees Supabase stays in sync even for deletions that happened while the browser was closed or the service worker was inactive.

## 11.3 Alarms

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
❌ Use `search_pinterest_pins_text` RPC — it is not deployed; use direct PostgREST GET query instead
❌ Use `setPointerCapture` in CanvasView — it routes all pointer events to the container, breaking `<a>` link navigation on desktop; use window-level listeners during drag instead

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
