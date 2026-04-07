# OpenMemory Web App

A Next.js web application for searching your bookmarks and Pinterest pins. Uses the same search algorithm as the Chrome extension for consistent results.

## Features

- **Unified Search**: Identical search logic to the Chrome extension
- **Hybrid Search**: Combines keyword matching with AI semantic search
- **Real-time Results**: 350ms debounced search as you type
- **Website Screenshots**: Bookmark cards show actual website previews
- **Source Filters**: Filter by All, Bookmarks, or Pinterest
- **Folder/Board Filters**: Narrow results by specific folders or boards
- **Responsive Design**: Works on mobile, tablet, and desktop
- **Animated UI**: Smooth transitions with video background
- **Smart Caching**: Embedding cache for instant repeated searches

## Getting Started

### Prerequisites

- Node.js 18+
- Backend server running on port 3001

### Start the Backend

```bash
cd ../backend
PORT=3001 npm start
```

### Start the Web App

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Search Behavior

The webapp search works exactly like the extension:

1. **Minimum 2 characters** required to trigger search
2. **350ms debounce** to wait for typing to finish
3. **Bookmarks appear first**, then Pinterest pins
4. **Keyword matches prioritized** over semantic similarity
5. **Recent items boosted** (30-day window)

### Scoring Formula

```
score = (0.55 × keyword) + (0.10 × semantic) + (0.15 × recency) + (0.20 × sourceBoost)
```

## Performance

### Response Times
| Query Type | Response Time |
|------------|---------------|
| Strong keyword match (e.g., "figma") | ~150-500ms |
| Cached query | ~100-200ms |
| Semantic search (e.g., "fintech") | ~5-8s |

### Optimizations
- **Embedding Cache**: LRU cache (100 entries) for instant repeated searches
- **Smart Vector Skip**: Skips slow semantic search when keyword matches are strong
- **Timeout Protection**: 8-second max wait for embedding generation

## Website Screenshots

Bookmark cards display website screenshots:
- Fetched from `screenshot.11ty.dev` service
- Favicon placeholder shown while loading
- Smooth fade-in transition on load
- Graceful fallback to favicon on error

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Styling**: Tailwind CSS
- **Icons**: Lucide React
- **Fonts**: Geist, Baloo Bhai 2, Baloo 2

## Project Structure

```
webapp/
├── src/
│   ├── app/
│   │   ├── page.tsx        # Main search page
│   │   ├── layout.tsx      # Root layout with fonts
│   │   └── globals.css     # Global styles
│   └── components/
│       ├── SearchResults.tsx      # Results grid
│       ├── SearchResultCard.tsx   # Individual result card
│       └── SearchFilters.tsx      # Filter buttons
├── public/
│   ├── videos/             # Background video
│   └── images/             # UI assets
└── package.json
```

## API Endpoints

The webapp communicates with the backend on `http://localhost:3001`:

| Endpoint | Description |
|----------|-------------|
| `GET /search?q=query` | Search bookmarks and pins |
| `GET /folders` | Get list of bookmark folders |
| `GET /boards` | Get list of Pinterest boards |

## License

MIT
