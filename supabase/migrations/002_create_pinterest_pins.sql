-- Create pinterest_pins table for semantic search
CREATE TABLE IF NOT EXISTS pinterest_pins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pin_id TEXT NOT NULL UNIQUE,
  board_name TEXT NOT NULL,
  board_url TEXT,
  title TEXT,
  description TEXT,
  pin_url TEXT NOT NULL,
  image_url TEXT,
  embedding vector(384), -- BAAI/bge-small-en-v1.5 dimension
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_pin_id ON pinterest_pins(pin_id);
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_board_name ON pinterest_pins(board_name);
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_synced_at ON pinterest_pins(synced_at);

-- Create HNSW index for fast vector similarity search
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_embedding ON pinterest_pins
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Function to search pinterest pins by vector similarity
CREATE OR REPLACE FUNCTION search_pinterest_pins(
  query_embedding vector(384),
  match_count INT DEFAULT 20,
  filter_board TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  pin_id TEXT,
  board_name TEXT,
  board_url TEXT,
  title TEXT,
  description TEXT,
  pin_url TEXT,
  image_url TEXT,
  similarity FLOAT,
  synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.pin_id,
    p.board_name,
    p.board_url,
    p.title,
    p.description,
    p.pin_url,
    p.image_url,
    1 - (p.embedding <=> query_embedding) AS similarity,
    p.synced_at
  FROM pinterest_pins p
  WHERE
    p.embedding IS NOT NULL
    AND (filter_board IS NULL OR p.board_name ILIKE filter_board || '%')
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Combined search function for both bookmarks and pinterest pins
CREATE OR REPLACE FUNCTION search_all_items(
  query_embedding vector(384),
  match_count INT DEFAULT 50,
  filter_folder TEXT DEFAULT NULL
)
RETURNS TABLE (
  source TEXT,
  item_id TEXT,
  url TEXT,
  title TEXT,
  folder_or_board TEXT,
  image_url TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  (
    -- Search bookmarks
    SELECT
      'chrome'::TEXT AS source,
      b.id::TEXT AS item_id,
      b.url,
      b.title,
      b.folder AS folder_or_board,
      NULL::TEXT AS image_url,
      1 - (b.embedding <=> query_embedding) AS similarity
    FROM bookmarks b
    WHERE
      b.embedding IS NOT NULL
      AND (filter_folder IS NULL OR b.folder ILIKE filter_folder || '%')
  )
  UNION ALL
  (
    -- Search pinterest pins
    SELECT
      'pinterest'::TEXT AS source,
      p.pin_id AS item_id,
      p.pin_url AS url,
      COALESCE(p.title, 'Pinterest Pin') AS title,
      p.board_name AS folder_or_board,
      p.image_url,
      1 - (p.embedding <=> query_embedding) AS similarity
    FROM pinterest_pins p
    WHERE
      p.embedding IS NOT NULL
      AND (filter_folder IS NULL OR p.board_name ILIKE filter_folder || '%')
  )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- Text search function for pinterest pins (fallback)
CREATE OR REPLACE FUNCTION search_pinterest_pins_text(
  search_query TEXT,
  match_count INT DEFAULT 20,
  filter_board TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  pin_id TEXT,
  board_name TEXT,
  board_url TEXT,
  title TEXT,
  description TEXT,
  pin_url TEXT,
  image_url TEXT,
  similarity FLOAT,
  synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.pin_id,
    p.board_name,
    p.board_url,
    p.title,
    p.description,
    p.pin_url,
    p.image_url,
    0.5::FLOAT AS similarity, -- Fixed score for text matches
    p.synced_at
  FROM pinterest_pins p
  WHERE
    (filter_board IS NULL OR p.board_name ILIKE filter_board || '%')
    AND (
      p.title ILIKE '%' || search_query || '%'
      OR p.description ILIKE '%' || search_query || '%'
      OR p.board_name ILIKE '%' || search_query || '%'
    )
  ORDER BY p.synced_at DESC
  LIMIT match_count;
END;
$$;

-- Trigger to auto-update updated_at timestamp
CREATE TRIGGER update_pinterest_pins_updated_at
  BEFORE UPDATE ON pinterest_pins
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions for anon role
GRANT SELECT, INSERT, UPDATE, DELETE ON pinterest_pins TO anon;
