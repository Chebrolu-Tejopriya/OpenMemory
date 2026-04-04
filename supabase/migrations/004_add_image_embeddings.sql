-- Migration: Add image embeddings for Pinterest pins
-- FastEmbed BGE-small-en-v1.5 for text (384 dim, unchanged)
-- CLIP ViT-B/32 for images (512 dim, new column)

-- Add image_embedding column for Pinterest visual sea.srch
ALTER TABLE pinterest_pins
ADD COLUMN IF NOT EXISTS image_embedding vector(512);

-- Create HNSW index for fast image similarity search
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_image_embedding ON pinterest_pins
USING hnsw (image_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Update search function to support image embeddings
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

-- New function: Search Pinterest pins by image embedding (CLIP)
CREATE OR REPLACE FUNCTION search_pinterest_pins_by_image(
  query_image_embedding vector(512),
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
    1 - (p.image_embedding <=> query_image_embedding) AS similarity,
    p.synced_at
  FROM pinterest_pins p
  WHERE
    p.image_embedding IS NOT NULL
    AND (filter_board IS NULL OR p.board_name ILIKE filter_board || '%')
  ORDER BY p.image_embedding <=> query_image_embedding
  LIMIT match_count;
END;
$$;

-- Updated combined search with image embedding support
CREATE OR REPLACE FUNCTION search_all_items(
  query_embedding vector(384),
  search_query TEXT,
  use_vector_only BOOLEAN DEFAULT FALSE,
  match_count INT DEFAULT 500,
  filter_folder TEXT DEFAULT NULL,
  filter_source TEXT DEFAULT NULL,
  filter_board TEXT DEFAULT NULL,
  include_image_search BOOLEAN DEFAULT FALSE,
  query_image_embedding vector(512) DEFAULT NULL
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
      -- Search bookmarks (text only)
      SELECT
        'chrome'::TEXT AS source,
        b.id::TEXT AS item_id,
        b.url,
        b.title,
        b.folder AS folder_or_board,
        NULL::TEXT AS image_url,
        b.embedding <=> query_embedding AS similarity_raw,
        0::FLOAT AS image_similarity_raw,
        b.created_at
      FROM bookmarks b
      WHERE
        b.embedding IS NOT NULL
        AND (filter_folder IS NULL OR b.folder ILIKE filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'chrome')
    )
    UNION ALL
    (
      -- Search pinterest pins (text + optional image)
      SELECT
        'pinterest'::TEXT AS source,
        p.pin_id AS item_id,
        p.pin_url AS url,
        COALESCE(p.title, 'Pinterest Pin') AS title,
        p.board_name AS folder_or_board,
        p.image_url,
        CASE WHEN p.embedding IS NOT NULL THEN p.embedding <=> query_embedding ELSE 2.0 END AS similarity_raw,
        CASE
          WHEN include_image_search AND query_image_embedding IS NOT NULL AND p.image_embedding IS NOT NULL
          THEN p.image_embedding <=> query_image_embedding
          ELSE 2.0
        END AS image_similarity_raw,
        p.created_at
      FROM pinterest_pins p
      WHERE
        (p.embedding IS NOT NULL OR (include_image_search AND p.image_embedding IS NOT NULL))
        AND (filter_folder IS NULL OR p.board_name ILIKE filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'pinterest')
        AND (filter_board IS NULL OR p.board_name ILIKE filter_board)
    )
  ),
  stats AS (
    SELECT
      MIN(similarity_raw) FILTER (WHERE similarity_raw < 2.0) AS min_raw,
      MAX(similarity_raw) FILTER (WHERE similarity_raw < 2.0) AS max_raw
    FROM combined
  ),
  scored AS (
    SELECT
      combined.source,
      combined.item_id,
      combined.url,
      combined.title,
      combined.folder_or_board,
      combined.image_url,
      combined.similarity_raw,
      combined.image_similarity_raw,
      combined.created_at,
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
      -- Combine text and image similarity (use best of both for Pinterest)
      CASE
        WHEN stats.max_raw IS NULL OR stats.min_raw IS NULL OR stats.max_raw = stats.min_raw THEN
          GREATEST(0, LEAST(1, 1 - (LEAST(combined.similarity_raw, combined.image_similarity_raw) / 2.0)))
        ELSE
          GREATEST(0, LEAST(1, 1 - ((LEAST(combined.similarity_raw, combined.image_similarity_raw) - stats.min_raw) / NULLIF(stats.max_raw - stats.min_raw, 0))))
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
    CASE WHEN use_vector_only THEN LEAST(scored.similarity_raw, scored.image_similarity_raw) ELSE NULL END ASC,
    final_score DESC
  LIMIT match_count;
END;
$$;

-- Function to update image embedding
CREATE OR REPLACE FUNCTION update_image_embedding(
  row_id uuid,
  embedding_input float8[]
)
RETURNS void AS $$
DECLARE
  embedding_text text;
BEGIN
  embedding_text := '[' || array_to_string(embedding_input, ',') || ']';

  UPDATE pinterest_pins
  SET image_embedding = embedding_text::vector
  WHERE id = row_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Update failed for id: %', row_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to clear all embeddings (for re-embedding with new model)
CREATE OR REPLACE FUNCTION clear_all_embeddings()
RETURNS void AS $$
BEGIN
  UPDATE bookmarks SET embedding = NULL;
  UPDATE pinterest_pins SET embedding = NULL, image_embedding = NULL;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT EXECUTE ON FUNCTION update_image_embedding(uuid, float8[]) TO anon;
GRANT EXECUTE ON FUNCTION clear_all_embeddings() TO anon;
GRANT EXECUTE ON FUNCTION search_pinterest_pins_by_image(vector(512), int, text) TO anon;
