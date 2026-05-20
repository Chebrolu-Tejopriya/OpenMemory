-- Add pinned flag and desktop position to sticky_notes
ALTER TABLE sticky_notes
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_x  INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pin_y  INTEGER DEFAULT NULL;

-- Index for fast pinned-note fetches
CREATE INDEX IF NOT EXISTS idx_sticky_notes_pinned ON sticky_notes (pinned) WHERE pinned = true;
