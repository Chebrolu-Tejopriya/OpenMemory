# OpenMemory

A Chrome extension and web app for semantic search of your design inspirations. Search your bookmarks and Pinterest pins using natural language and find relevant design resources instantly.

## Features

- **Hybrid Search**: Combines keyword matching with AI semantic search (vector embeddings)
- **Keyword-First Ranking**: Exact matches appear at the top before semantic results
- **Pinterest Integration**: Sync and search your Pinterest pins alongside bookmarks
- **Bookmarks Priority**: Chrome bookmarks always appear before Pinterest pins
- **Recency Boost**: Recently saved items get higher ranking
- **Query Expansion**: Automatic synonym matching for design terms
- **Folder Filtering**: Use `@` to filter by bookmark folders
- **Board Filtering**: Filter Pinterest results by board
- **Website Thumbnails**: Preview sites with automatic screenshots
- **Web App**: Standalone Next.js web app with identical search functionality
- **Dark UI**: Clean Vercel-inspired dark theme

## Architecture

```
extension/
├── src/extension/          # Chrome extension source
│   ├── manifest.json       # Extension manifest v3
│   ├── sidepanel.html      # Main UI
│   ├── search.ts           # Client-side search logic
│   └── background.ts       # Service worker
├── backend/                # Express API server
│   └── src/
│       ├── server.ts       # API endpoints
│       ├── supabase-search.ts  # Unified search logic (matches extension)
│       ├── embeddings.ts   # FastEmbed BGE embeddings generation
│       └── db.ts           # Database layer
├── webapp/                 # Next.js web application
│   └── src/
│       ├── app/page.tsx    # Main search UI
│       └── components/     # React components
├── supabase/               # Supabase migrations and setup
├── dist/                   # Built extension (generated)
└── scripts/                # Build utilities
```

## Prerequisites

- Node.js 18+
- Chrome browser
- OpenAI API key (for generating embeddings)

## Setup Instructions

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd extension
```

### 2. Install Dependencies

```bash
# Install extension dependencies
npm install

# Install backend dependencies
cd backend
npm install
```

### 3. Configure Environment

Create a `.env` file in the `backend/` folder:

```bash
cd backend
echo "OPENAI_API_KEY=your-openai-api-key" > .env
```

### 4. Import Your Chrome Bookmarks

This reads bookmarks from your Chrome profile, scrapes metadata, and generates embeddings:

```bash
cd backend
npm run import
```

> **Note**: This process may take a while depending on the number of bookmarks. It scrapes each URL for metadata and generates vector embeddings.

### 5. Export Data for Extension

```bash
npm run export
```

This creates `dist/data.json` with all your bookmarks and embeddings.

### 6. Build the Extension

```bash
cd ..
npm run build
```

### 7. Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Click the extension icon to open the side panel

## Usage

### Basic Search

Type any search query to find relevant bookmarks:
- `dashboard design` - finds dashboard UI inspiration
- `landing page examples` - finds landing page designs
- `minimal portfolio` - finds minimalist portfolio sites

### Folder Filtering

Use `@` to filter by folder:
- `@design` - shows folder suggestions starting with "design"
- `buttons @ui` - searches "buttons" within UI folder

### Keyboard Navigation

- `↑/↓` - Navigate folder suggestions
- `Enter` - Select folder
- `Escape` - Close suggestions

## Development

### Available Scripts

**Extension (root folder):**

```bash
npm run build       # Build extension to dist/
npm run build:ts    # Compile TypeScript only
npm run build:icons # Generate extension icons
npm run typecheck   # Type check without building
```

**Backend:**

```bash
cd backend
npm run dev         # Run server in development mode
npm run import      # Import Chrome bookmarks
npm run export      # Export data.json for extension
npm run typecheck   # Type check
```

### Project Structure

| File | Description |
|------|-------------|
| `src/extension/search.ts` | Client-side search with intent filtering |
| `src/extension/sidepanel.html` | Main UI with Vercel dark theme |
| `backend/src/import-chrome-bookmarks.ts` | Reads Chrome bookmarks file |
| `backend/src/scraper.ts` | Scrapes website metadata (title, description, OG tags) |
| `backend/src/embeddings.ts` | Generates OpenAI text-embedding-3-small vectors |
| `backend/src/intent.ts` | Classifies bookmark intent (inspiration, learning, etc.) |
| `backend/src/export.ts` | Exports SQLite data to JSON for extension |

## How It Works

1. **Import**: Reads bookmarks from Chrome's local storage
2. **Scrape**: Fetches metadata from each URL (title, description, Open Graph tags)
3. **Embed**: Generates vector embeddings using FastEmbed BGE-small model
4. **Store**: Saves to Supabase with pgvector for similarity search
5. **Search**: Hybrid text + vector search with unified scoring

## Search Algorithm

Both the extension and webapp use identical search logic:

### Scoring Formula
```
combinedScore = (0.55 × keywordScore) + (0.10 × semanticScore) + (0.15 × recencyScore) + (0.20 × sourceBoost)
```

### Keyword Scoring (Hierarchical)
| Score | Match Type |
|-------|------------|
| 1.0 | Exact title match |
| 0.8 | Title contains query |
| 0.75 | URL contains query |
| 0.7 | All terms found in title |
| 0.55 | >50% of terms in title |
| 0.5 | URL contains any term |
| 0.4 | Folder/board contains query |
| 0.35 | Folder contains any term |
| 0.3 | Description contains query |
| 0.15 | Any term found anywhere |

### Query Expansion
Automatic synonym matching for common design terms:
- `dashboard` → admin, panel, analytics, metrics
- `fintech` → finance, banking, payment, crypto
- `mobile` → app, ios, android, responsive
- `landing` → homepage, hero, marketing

### Source Priority
- Chrome bookmarks always appear before Pinterest pins
- Within each source, results are sorted by keyword score, then combined score

### Recency Boost
Items saved within the last 30 days get a recency boost (0-1 scale based on age)

## Intent Classification

The search prioritizes design inspiration by:
- Boosting items in folders like `design`, `ui`, `inspiration`
- Boosting items with titles containing design keywords
- Filtering out developer/tutorial content for inspiration queries

## Tech Stack

- **Extension**: TypeScript, Chrome Extension Manifest V3, Side Panel API
- **Backend**: Node.js, TypeScript, SQLite (better-sqlite3), OpenAI API
- **Build**: esbuild
- **Styling**: Vanilla CSS (Vercel dark theme)

## License

MIT
