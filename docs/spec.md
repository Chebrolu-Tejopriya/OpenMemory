# OpenMemory — SYSTEM SPEC (SOURCE OF TRUTH)

This document defines EXACT behavior, architecture, and constraints.
Claude MUST follow this strictly. No assumptions. No deviations.

---

# 1. PRODUCT DEFINITION

OpenMemory is a:

> Personal inspiration memory system with semantic search

Users can:

* Save content (Chrome bookmarks, Pinterest pins)
* Search using natural language ("dark fintech dashboard")
* Filter by source, folder, board, and time
* Retrieve relevant inspiration instantly

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
│  ├── sidepanel.html (UI - dark theme)                       │
│  ├── search.ts (hybrid search: vector + text)               │
│  ├── background.ts (service worker, alarms, sync)           │
│  ├── supabase.ts (cloud CRUD operations)                    │
│  ├── pinterest.ts + pinterest_active.ts (Pinterest sync)    │
│  └── db.ts (IndexedDB via Dexie.js)                         │
├─────────────────────────────────────────────────────────────┤
│  Local Backend (localhost:3000)                             │
│  ├── Express server with SQLite (better-sqlite3)            │
│  ├── FastEmbed / Python for embedding generation            │
│  └── Endpoints: /embed, /search, /pinterest/ingest          │
├─────────────────────────────────────────────────────────────┤
│  Supabase (Cloud)                                           │
│  ├── PostgreSQL + pgvector extension                        │
│  ├── HNSW indexes for fast vector search                    │
│  ├── RPC functions for combined search                      │
│  └── Edge Function: generate-embedding                      │
└─────────────────────────────────────────────────────────────┘
```

## 3.2 Data Flow

```
User Search Query
    ↓
Extension generates embedding (POST localhost:3000/embed)
    ↓
Supabase RPC: search_all_items(query_embedding, filters)
    ↓
Combined scoring: vector + keyword + recency
    ↓
Results displayed in 2-column grid
```

## 3.3 Architecture Rules

❌ NO serverless complexity
❌ NO queues or background workers
❌ NO multiple databases per user
❌ NO per-user database instances
✅ Single Supabase project for all data
✅ Local backend for embedding generation only

---

# 4. DATABASE SCHEMA (STRICT)

## 4.1 bookmarks

```sql
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

-- Indexes
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id TEXT UNIQUE,
  board_name TEXT,
  board_url TEXT,
  title TEXT,
  description TEXT,
  pin_url TEXT UNIQUE,
  image_url TEXT,
  embedding vector(384),
  image_embedding vector(512),
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_pinterest_pins_pin_id ON pinterest_pins(pin_id);
CREATE INDEX idx_pinterest_pins_board_name ON pinterest_pins(board_name);
CREATE INDEX idx_pinterest_pins_synced_at ON pinterest_pins(synced_at DESC);
CREATE INDEX idx_pinterest_pins_embedding ON pinterest_pins
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_pinterest_pins_image_embedding ON pinterest_pins
  USING hnsw (image_embedding vector_cosine_ops);
```

## 4.3 pinterest_boards

```sql
CREATE TABLE pinterest_boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_name TEXT,
  board_url TEXT UNIQUE,
  total_pins INTEGER DEFAULT 0,
  imported_pins INTEGER DEFAULT 0,
  last_synced_at TIMESTAMPTZ
);
```

## 4.4 Schema Rules

* URLs are UNIQUE - prevents duplicates
* Embeddings: 384 dimensions for text (STRICT)
* Image embeddings: 512 dimensions (CLIP model)
* Embedding format: `Array<number>` (NOT Float32Array)
* NEVER change embedding dimensions
* NEVER create per-user tables

---

# 5. EMBEDDING SYSTEM (CRITICAL)

## 5.1 Models

| Type | Model | Dimensions |
|------|-------|------------|
| Text | BAAI/bge-small-en-v1.5 | 384 |
| Image | openai/clip-vit-base-patch32 | 512 |

## 5.2 Generation Pipeline

**Local Backend (localhost:3000/embed):**
```
Text → FastEmbed (Python) → 384-dim array → Return
```

**Supabase Edge Function (generate-embedding):**
```
Text/Image → HuggingFace Inference API → 384/512-dim → Return
```

## 5.3 Embedding Rules (STRICT)

✅ MUST be `Array<number>`
✅ MUST be exactly 384 dimensions (text)
✅ MUST use `Array.from(output.data)` conversion

❌ NEVER use Float32Array directly
❌ NEVER nest arrays `[...][...]`
❌ NEVER change dimensions

## 5.4 Backfill Script

```bash
npx tsx scripts/generateEmbeddings.ts
```

Behavior:
* Fetch rows where `embedding IS NULL`
* Generate embedding via Python FastEmbed
* Update via RPC `update_embedding(id, embedding_array)`
* Batch size: 50

---

# 6. SEARCH SYSTEM (CRITICAL)

## 6.1 Search Modes

**Primary: Supabase Vector Search**
* Requires Supabase configuration
* Uses HNSW index for fast similarity
* Combined with keyword matching

**Fallback: Local Text Search**
* Uses MiniSearch library
* Searches IndexedDB cache
* Field weights: title 2x, folder 1.5x

## 6.1.1 Query Understanding

**Query Expansion**: Automatic synonym expansion for design terms
```
dashboard → admin, panel, analytics, metrics
ui → interface, design, ux
fintech → finance, banking, payment, crypto
mobile → app, ios, android, responsive
landing → homepage, hero, marketing
```

**Multi-word Matching**: Improved scoring for multi-term queries
* All terms match in title → 0.7
* >50% terms match → 0.55
* Expanded terms match → 0.1-0.25

## 6.2 Scoring Formula (MANDATORY)

```
FINAL_SCORE = 0.55 × keyword_match    (PRIMARY - exact word matches)
            + 0.10 × vector_similarity (secondary - semantic context)
            + 0.15 × recency
            + 0.20 × source_boost
```

**Keyword-First Search**: Exact keyword matches always appear first.
**Source Boost**: Bookmarks = 1.0, Pinterest = 0.0

**Search Priority Order:**
1. Exact keyword matches in title
2. Partial keyword matches
3. Semantically similar items (vector search)

### Vector Similarity (0-1)
```sql
-- Normalized cosine distance
1 - (embedding <=> query_embedding)
```

### Keyword Match (0-1)
```sql
-- Multi-term aware scoring (SQL)
CASE
  WHEN title = query THEN 1.0                    -- Exact match
  WHEN title LIKE '%' || query || '%' THEN 0.8  -- Contains full query
  WHEN all_terms_in_title THEN 0.7              -- All query terms found
  WHEN >50%_terms_in_title THEN 0.5             -- Most terms found
  WHEN folder LIKE '%' || query || '%' THEN 0.4 -- Folder match
  WHEN any_term_in_title THEN 0.3               -- Partial term match
  WHEN url LIKE '%' || query || '%' THEN 0.2    -- URL match
  ELSE 0
END
```

**Client-side scoring tiers:**
| Score | Condition |
|-------|-----------|
| 1.0 | Exact title match |
| 0.8 | Title contains full query |
| 0.7 | All original terms in title |
| 0.55 | >50% terms in title |
| 0.4 | Board/folder contains query |
| 0.35 | Board contains any term |
| 0.3 | Description contains query |
| 0.1-0.25 | Expanded synonym matches |
| 0.1 | Any term found anywhere |

### Recency (0-1)
```sql
-- Decay over 30 days (2592000 seconds)
GREATEST(0, 1 - (EXTRACT(EPOCH FROM now() - updated_at) / 2592000))
```

## 6.3 Search RPC Function

```sql
search_all_items(
  query_embedding vector(384),
  search_query TEXT,
  use_vector_only BOOLEAN DEFAULT false,
  match_count INTEGER DEFAULT 30,
  filter_source TEXT DEFAULT NULL,
  filter_folder TEXT DEFAULT NULL,
  filter_board TEXT DEFAULT NULL
)
```

Returns:
```sql
source TEXT,           -- 'chrome' or 'pinterest'
item_id UUID,
url TEXT,
title TEXT,
folder_or_board TEXT,
image_url TEXT,
similarity FLOAT,
keyword_score FLOAT,
recency_score FLOAT,
final_score FLOAT
```

## 6.4 Result Limits

```
MAX_RESULTS = 30 (default)
BATCH_SIZE = 20 (pagination)
```

---

# 7. FILTERS (IMPLEMENTED)

## 7.1 Source Filter

```
All | Chrome Bookmarks | Pinterest
```

Applied as: `WHERE source = 'chrome'` or `WHERE source = 'pinterest'`

## 7.2 Folder Filter (Chrome)

* Dropdown populated from unique `folder` values
* Syntax in search: `@design` or `@ui/components`
* Applied as: `WHERE folder ILIKE '%' || filter || '%'`

## 7.3 Board Filter (Pinterest)

* Dropdown populated from unique `board_name` values
* Applied as: `WHERE board_name = filter`

## 7.4 Time Filter

* **Recent**: Items from last 30 days
* **Older**: Items older than 30 days

---

# 8. API ENDPOINTS

## 8.1 Local Backend (localhost:3000)

### POST /embed
```json
Request:  { "text": "dark fintech dashboard" }
Response: { "embedding": [0.123, -0.456, ...] }  // 384 floats
```

### POST /search
```json
Request:  { "query": "dashboard", "limit": 30, "folder": "design" }
Response: [{ "id": "...", "title": "...", "score": 0.85 }, ...]
```

### POST /pinterest/ingest
```json
Request:  { "pins": [{ "pin_id": "...", "title": "...", ... }] }
Response: { "success": true, "count": 50 }
```

### POST /run-embeddings
```
Purpose: Trigger batch embedding generation after import
Response: { "processed": 50, "remaining": 100 }
```

### GET /folders
```
Response: { "folders": ["Design", "UI/Components", "Reference"] }
```

## 8.2 Supabase Edge Function

### POST /functions/v1/generate-embedding

```json
Request: {
  "text": "search query",      // OR
  "image_url": "https://...",
  "type": "text"               // or "image"
}
Response: { "embedding": [...] }  // 384 or 512 floats
```

---

# 9. CHROME EXTENSION STRUCTURE

## 9.1 Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `background.ts` | ~2000 | Service worker, alarms, bookmark monitoring |
| `search.ts` | ~2600 | Hybrid search logic, result formatting |
| `supabase.ts` | ~1000 | Supabase client, CRUD operations |
| `pinterest.ts` | ~950 | Pinterest content script |
| `pinterest_active.ts` | ~1400 | Deep scroll, API interception |
| `sidepanel.html` | ~1250 | UI with dark theme |
| `db.ts` | ~200 | IndexedDB (Dexie.js) layer |

## 9.2 IndexedDB Schema (Dexie.js)

```typescript
// bookmarks - local cache
++id, &url, title, folder, indexStatus, extendedContent

// pins - Pinterest cache
++id, &pinId, boardName, title, imageBlob, syncedAt

// integrations - connection status
++id, &name, connected, syncStatus, lastSyncAt

// queue - indexing queue
++id, url, priority, createdAt
```

## 9.3 Chrome Alarms

| Alarm | Interval | Purpose |
|-------|----------|---------|
| `checkIndexing` | 2 min | Process metadata fetching queue |
| `pinterestSync` | 1 hour | Sync Pinterest boards |
| `supabaseAutoSync` | 5 min | Auto-sync to Supabase |

---

# 10. PINTEREST INTEGRATION

## 10.1 Features

* Login detection via cookies
* Board list fetching (API interception)
* Deep scroll for full board sync
* Image conversion to WebP (offscreen document)
* Incremental sync with checkpoints

## 10.2 Data Extraction Methods

1. **API Interception**: Intercept XHR/Fetch to api.pinterest.com
2. **DOM Scraping**: Parse HTML as fallback
3. **Deep Scroll**: Simulate scrolling for infinite load

## 10.3 Sync Flow

```
User clicks "Sync All"
    ↓
Detect Pinterest login (cookie check)
    ↓
Fetch board list via API interception
    ↓
User selects boards → Start sync
    ↓
For each board:
  - Deep scroll to load all pins
  - Extract pin metadata
  - Convert images to WebP
  - Store in IndexedDB
    ↓
Batch sync to Supabase
    ↓
Trigger embedding generation
```

---

# 11. CHROME BOOKMARKS INTEGRATION

## 11.1 Real-time Sync

```typescript
// Event listeners in background.ts
chrome.bookmarks.onCreated  → upsertBookmark()
chrome.bookmarks.onRemoved  → deleteBookmark()
chrome.bookmarks.onChanged  → updateBookmark()
chrome.bookmarks.onMoved    → updateBookmark()
```

## 11.2 Sync Behavior

* UPSERT on create/update (dedupe by URL)
* DELETE on remove
* Auto-generate embedding via Edge Function
* Batch sync every 5 minutes

---

# 12. UI/UX DESIGN

## 12.1 Theme

* **Background**: Black (#000000)
* **Text**: White (#FFFFFF)
* **Secondary text**: Gray (#888888)
* **Pinterest badge**: Red (#E60023)
* **Chrome badge**: Blue (#4285F4)
* **Success/Connected**: Green (#4ade80)

## 12.2 Layout

* Side panel (400px width)
* 2-column grid for results
* Card design with thumbnails
* Sticky search header
* Collapsible integrations panel

## 12.3 Search UX

* Instant search on typing (debounced 300ms)
* Folder autocomplete with `@` prefix
* Filter chips (removable)
* "Load more" pagination
* Empty state messaging

---

# 13. PERFORMANCE TARGETS

| Metric | Target |
|--------|--------|
| Supabase vector search | < 500ms |
| Local text search | < 50ms |
| Embedding generation | < 5s (first call) |
| UI render | < 100ms |

## 13.1 Optimization Rules

* Always use HNSW indexes for vector columns
* Limit results to 30 by default
* Batch operations (20-50 items)
* Cache embeddings locally
* Use pagination, not infinite scroll

---

# 14. CURRENT PRIORITY

Focus ONLY on:

```
1. Search ranking quality
2. Filter functionality
3. UX improvements
4. Performance optimization
```

---

# 15. WHAT CLAUDE MUST NEVER DO

❌ Change database schema unnecessarily
❌ Introduce new services or dependencies
❌ Modify embedding dimensions
❌ Add complexity without clear benefit
❌ Rebuild existing architecture
❌ Create new files when editing existing ones works
❌ Add features not explicitly requested
❌ Use Float32Array for embeddings
❌ Skip reading files before editing

---

# 16. SUCCESS CRITERIA

Search should feel:

```
✓ Fast (< 500ms response)
✓ Relevant (semantic understanding)
✓ Predictable (consistent ranking)
✓ Useful (finds what user wants)
```

---

# 17. FUTURE ENHANCEMENTS (NOT CURRENT PRIORITY)

## 17.1 Authentication (Phase 2)
* Firebase integration
* User isolation: `WHERE user_id = auth.uid()`
* Multi-account support

## 17.2 Public Sharing (Phase 3)
* Collections table with `is_public` flag
* Read-only sharing links
* Social features

## 17.3 Advanced Search (Phase 4)
* Image-to-image search (CLIP embeddings ready)
* Cross-modal search
* Semantic clustering

---

# END OF SPEC
