-- Sticky notes table — synced across devices via Supabase
CREATE TABLE IF NOT EXISTS sticky_notes (
  id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT,
  color_bg TEXT NOT NULL DEFAULT '#fde68a',
  color_text TEXT NOT NULL DEFAULT '#78350f',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for ordering by creation time
CREATE INDEX IF NOT EXISTS idx_sticky_notes_created_at ON sticky_notes(created_at);

-- Grant anon role full access (RLS is off, same as bookmarks table)
GRANT SELECT, INSERT, UPDATE, DELETE ON sticky_notes TO anon;
