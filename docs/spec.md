Project Version: 1.2 (Architect’s Edition)
Visual Theme: Vercel Dark (High-Contrast Minimalist)
Status: MPP (Minimum Possible Product)
1. Product Vision & Mission
1.1 Product Vision
To create a "Unified Memory" for designers. Designers find inspiration everywhere—X, Instagram, Pinterest, and Chrome Bookmarks—but these inspirations are silos. OpenMemory breaks the silos by aggregating all saved content into a single, searchable, local-first visual brain.
1.2 Mission
To provide a hyper-fast, ultra-minimalist tool that stays in the designer's flow, allowing them to search thousands of scattered inspirations in seconds without ever leaving their active browser tab.
2. Design Philosophy: "The Vercel Aesthetic"
The UI should feel like a premium developer tool—clean, sharp, and fast.
Background: Pure Black (#000000).
Surface/Cards: #000000 with subtle 1px borders (#333333) to define shapes.
Typography: Geist Sans or Inter. White text (#FFFFFF) for headers, Muted Gray (#888888) for secondary info.
Search Input: A minimal pill or rectangle with a subtle border that glows white upon focus.
Hover States: Cards should show a subtle border highlight or a slight lift effect (Vercel-style).
3. Product Requirements Template (PRT)
3.1 Functional Requirements (MPP - Local Search Only)
ID	Feature	Description
F1.1	Bookmark Sync	Recursively scan all Chrome Bookmarks and flatten them into a searchable list.
F1.2	Path Breadcrumbs	Display the folder hierarchy using Vercel-style slash separators (e.g., Design / UI / Web).
F1.3	Instant Search	Global search bar that filters titles and paths. Zero-latency filtering.
F1.4	Side Panel UI	Default view for OpenMemory, allowing it to sit alongside design tools like Figma.
F1.5	Navigation	Minimalist top-nav containing the logo and a muted "Integrations" link.
3.2 Functional Requirements (V1 - Integration & Intelligence)
ID	Feature	Description
F2.1	Passive Scrapers	Automated DOM scraping for X, Instagram, LinkedIn, and Pinterest (No API keys needed).
F2.2	Blob Storage	Save images as compressed WebP Blobs in IndexedDB to prevent broken links.
F2.3	Integration Hub	A dedicated view to manage "Passive Capture" settings for social platforms.
F2.4	AI Auto-Tagging	Local processing via Chrome Gemini Nano to add "Mood" and "Style" tags automatically.
4. Technical Architecture
4.1 Implementation Stack
Frontend: HTML5, Tailwind CSS (Custom Config for Vercel colors).
Database: Dexie.js (IndexedDB) for local data persistence.
Extension Framework: Chrome Manifest V3.
Image Pipeline: Favicon Grabber (MPP) 
 Canvas-to-WebP Compressor (V1).
4.2 Data Schema
code
TypeScript
{
  id: string;               // Hash of the URL
  source: 'chrome' | 'x' | 'pinterest' | 'instagram' | 'linkedin';
  url: string;              // Original source link
  thumbnail: string | Blob; // High-res favicon (MPP) or WebP Blob (V1)
  title: string;            // Bookmark/Post title
  path: string;             // Hierarchy (e.g., "Design / Inspo")
  timestamp: number;        // Date added
}
5. UI Component Specifications (Vercel Style)
5.1 The Search Bar
Style: Background #000000, Border 1px solid #333333, Rounded 6px.
Focus: Border changes to #FFFFFF.
Placeholder: "Search inspirations..." in #888888.
5.2 The Inspiration Card
Style: No background (transparent) or #000000.
Thumbnail: 16:9 ratio, object-cover, rounded 8px.
Title: Bold white text, text-sm, truncate after 1 line.
Path: text-xs, color #888888.
6. Implementation Roadmap
Phase 1: MPP (The Search Core)
Goal: Perfect Chrome Bookmark search.
UI: Black-theme Side Panel with Vercel borders.
Logic: Recursive bookmark fetching and flattening.
Search: Instant real-time filtering.
Phase 2: V1 Foundation (Integrations)
Goal: Social aggregation.
Feature: Add "Integrations" dashboard.
Feature: Implement DOM scrapers for X and Pinterest.
Storage: Shift to IndexedDB for large-scale data.
7. Agent Instruction Log
Identity: Name the application OpenMemory.
Aesthetic: Reference Vercel Dark Mode. Use #000000 background and #333333 borders.
Local-First: Everything must work locally. No cloud sync, no accounts.
No APIs: For social platforms, plan for DOM scraping in V1. Use chrome.bookmarks for MPP.
Simplicity: MPP must be a single-view search experience. No tabs or side-menus yet.