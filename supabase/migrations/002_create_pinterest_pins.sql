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
  embedding vector(384), -- all-MiniLM-L6-v2 dimension
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
  match_count INT DEFAULT 500,
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
  search_query TEXT,
  use_vector_only BOOLEAN DEFAULT FALSE,
  match_count INT DEFAULT 500,
  filter_folder TEXT DEFAULT NULL,
  filter_source TEXT DEFAULT NULL,
  filter_board TEXT DEFAULT NULL
)
RETURNS TABLE (
  source TEXT,
  item_id TEXT,
  url TEXT,
  title TEXT,
  folder_or_board TEXT,
  image_url TEXT,
  similarity FLOAT,
  similarity_raw FLOAT,
  keyword_score FLOAT,
  recency_score FLOAT,
  final_score FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH combined AS (
    (
      -- Search bookmarks
      SELECT
        'chrome'::TEXT AS source,
        b.id::TEXT AS item_id,
        b.url,
        b.title,
        b.folder AS folder_or_board,
        NULL::TEXT AS image_url,
        b.embedding <=> query_embedding AS similarity_raw,
        b.created_at
      FROM bookmarks b
      WHERE
        b.embedding IS NOT NULL
        AND (filter_folder IS NULL OR b.folder ILIKE filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'chrome')
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
        p.embedding <=> query_embedding AS similarity_raw,
        p.created_at
      FROM pinterest_pins p
      WHERE
        p.embedding IS NOT NULL
        AND (filter_folder IS NULL OR p.board_name ILIKE filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'pinterest')
        AND (filter_board IS NULL OR p.board_name ILIKE filter_board)
    )
  ),
  stats AS (
    SELECT
      MIN(similarity_raw) AS min_raw,
      MAX(similarity_raw) AS max_raw
    FROM combined
  ),
  scored AS (
    SELECT
      combined.*,
      CASE
        WHEN search_query IS NULL OR btrim(search_query) = '' THEN 0
        WHEN combined.title ILIKE search_query THEN 1.0
        WHEN combined.title ILIKE '%' || search_query || '%' THEN 0.6
        WHEN combined.folder_or_board ILIKE '%' || search_query || '%' THEN 0.4
        ELSE 0
      END AS keyword_score,
      CASE
        WHEN combined.created_at IS NULL THEN 0
        ELSE GREATEST(
          0,
          1 - LEAST(EXTRACT(EPOCH FROM (NOW() - combined.created_at)) / 2592000.0, 1)
        )
      END AS recency_score,
      CASE
        WHEN stats.max_raw IS NULL OR stats.min_raw IS NULL OR stats.max_raw = stats.min_raw THEN
          GREATEST(0, LEAST(1, 1 - (combined.similarity_raw / 2.0)))
        ELSE
          GREATEST(0, LEAST(1, 1 - ((combined.similarity_raw - stats.min_raw) / NULLIF(stats.max_raw - stats.min_raw, 0))))
      END AS similarity
    FROM combined
    CROSS JOIN stats
  )
  SELECT
    scored.source,
    scored.item_id,
    scored.url,
    scored.title,
    scored.folder_or_board,
    scored.image_url,
    scored.similarity,
    scored.similarity_raw,
    scored.keyword_score,
    scored.recency_score,
    CASE
      WHEN use_vector_only THEN scored.similarity
      ELSE (0.2 * scored.similarity) + (0.6 * scored.keyword_score) + (0.2 * scored.recency_score)
    END AS final_score,
    scored.created_at
  FROM scored
  ORDER BY
    CASE WHEN use_vector_only THEN scored.similarity_raw ELSE NULL END ASC,
    final_score DESC
  LIMIT match_count;
END;
$$;

-- Text search function for pinterest pins (fallback)
CREATE OR REPLACE FUNCTION search_pinterest_pins_text(
  search_query TEXT,
  match_count INT DEFAULT 500,
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

-- RPC to update embeddings using vector cast (bypass PostgREST serialization)
CREATE OR REPLACE FUNCTION update_embedding(
  row_id uuid,
  embedding_input float8[]
)
RETURNS void AS $$
DECLARE
  embedding_text text;
BEGIN
  embedding_text := '[' || array_to_string(embedding_input, ',') || ']';

  UPDATE pinterest_pins
  SET embedding = embedding_text::vector
  WHERE id = row_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update failed for id: %', row_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_embedding_dim(
  row_id uuid
)
RETURNS integer AS $$
DECLARE
  dim integer;
BEGIN
  SELECT vector_dims(embedding) INTO dim
  FROM pinterest_pins
  WHERE id = row_id;

  IF dim IS NULL THEN
    RETURN 0;
  END IF;

  RETURN dim;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions for anon role
GRANT SELECT, INSERT, UPDATE, DELETE ON pinterest_pins TO anon;
GRANT EXECUTE ON FUNCTION update_embedding(uuid, float8[]) TO anon;
GRANT EXECUTE ON FUNCTION get_embedding_dim(uuid) TO anon;
