-- Create pinterest_boards table for board tracking
CREATE TABLE IF NOT EXISTS pinterest_boards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  board_name TEXT,
  board_url TEXT UNIQUE,
  total_pins INTEGER,
  imported_pins INTEGER DEFAULT 0,
  last_synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pinterest_boards_last_synced_at ON pinterest_boards(last_synced_at);

-- Ensure pinterest_pins has required columns
ALTER TABLE pinterest_pins ADD COLUMN IF NOT EXISTS pin_url TEXT;
ALTER TABLE pinterest_pins ADD COLUMN IF NOT EXISTS image TEXT;
ALTER TABLE pinterest_pins ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE pinterest_pins ADD COLUMN IF NOT EXISTS board_url TEXT;

DO $$
BEGIN
  ALTER TABLE pinterest_pins
    ADD CONSTRAINT pinterest_pins_pin_url_key UNIQUE (pin_url);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_pinterest_pins_board_url ON pinterest_pins(board_url);

GRANT SELECT, INSERT, UPDATE, DELETE ON pinterest_boards TO anon;
