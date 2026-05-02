# Next Steps

## Insights / Home Widgets

Widgets live on the **search page (renamed Home)** below the search bar, visible only in the pre-search (default) state. When the user searches, results replace the widgets as they do today. Headline "Find what inspires you" stays.

### Layout (pre-search state)
1. **Stat cards row** — 4 small frosted glass cards: total bookmarks, pins, notes, links
2. **Activity chart** — combined stacked bar chart below the cards, all 4 types by day for last 30 days

### Data sources
- Notes count + links count: already in local state, free
- Bookmarks + pins count: approximate from cached folder/board data (no new Supabase queries needed)
- Activity over time: 4 Supabase RPC functions returning `{date, count}[]` for last 30 days, cached 24hrs

### Implementation plan (agreed before starting)
- 4 Supabase RPC functions:
  - `get_bookmark_activity()` — bookmarks added per day
  - `get_pin_activity()` — pins synced per day
  - `get_note_activity()` — notes created per day
  - `get_link_activity()` — links saved per day
- New backend endpoints, cached 24hrs (historical data never changes)
- Frontend: `recharts` stacked bar chart
- Widgets animate out when search results come in (same transition as headline today)

### Constraints
- All aggregation server-side (RPC) — never fetch raw rows to count
- 24hr cache TTL on activity endpoints to protect egress
- No new tab in the dock — stays within the existing Search/Home tab
