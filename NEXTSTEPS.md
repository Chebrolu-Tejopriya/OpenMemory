# Next Steps

## Insights Dashboard

A new tab in the bottom dock showing high-level analytics for all saved data.

### Concept
Activity-over-time charts showing when data was added/synced — bookmarks, pins, notes, links — using `created_at` timestamps already stored in Supabase.

### Visual direction
- Bar chart or GitHub-style heatmap per data type
- Stat cards: total counts for bookmarks, pins, notes, links
- Same frosted glass aesthetic as the rest of the app

### Implementation plan (agreed before starting)
- 4 Supabase RPC functions returning `{date, count}[]` for last 30 days:
  - `get_bookmark_activity()`
  - `get_pin_activity()`
  - `get_note_activity()`
  - `get_link_activity()`
- Backend caches results for 24hrs (yesterday's activity never changes)
- Frontend: `recharts` for bar charts (lightweight, Next.js friendly)
- New 5th tab in bottom dock ("Insights")

### Constraints
- All aggregation done server-side (RPC) — never fetch raw rows just to count
- Cache aggressively (24hr TTL) to protect egress quota
