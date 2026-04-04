-- Migration 006: Fix search functions with proper timestamp casting and timeout handling

-- Fix search_bookmarks function (vector search)
DROP FUNCTION IF EXISTS search_bookmarks(vector(384), INT, TEXT);

CREATE OR REPLACE FUNCTION search_bookmarks(
  query_embedding vector(384),
  match_count INT DEFAULT 500,
  filter_folder TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  url TEXT,
  title TEXT,
  folder TEXT,
  chrome_id TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id,
    b.url,
    b.title,
    b.folder,
    b.chrome_id,
    1 - (b.embedding <=> query_embedding) AS similarity,
    b.created_at::TIMESTAMPTZ,
    b.updated_at::TIMESTAMPTZ
  FROM bookmarks b
  WHERE
    b.embedding IS NOT NULL
    AND (filter_folder IS NULL OR b.folder ILIKE '%' || filter_folder || '%')
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_bookmarks(vector(384), INT, TEXT) TO anon;

-- Fix search_pinterest_pins function (vector search) with timeout handling
DROP FUNCTION IF EXISTS search_pinterest_pins(vector(384), INT, TEXT);

CREATE OR REPLACE FUNCTION search_pinterest_pins(
  query_embedding vector(384),
  match_count INT DEFAULT 500,
  filter_board TEXT DEFAULT NULL
)
RETURNS TABLE (
  pin_id TEXT,
  pin_url TEXT,
  title TEXT,
  description TEXT,
  image_url TEXT,
  board_name TEXT,
  similarity FLOAT,
  similarity_raw FLOAT,
  synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Set a statement timeout for this function to prevent long-running queries
  SET LOCAL statement_timeout = '10s';

  RETURN QUERY
  SELECT
    p.pin_id,
    p.pin_url,
    p.title,
    p.description,
    p.image_url,
    p.board_name,
    1 - (p.embedding <=> query_embedding) AS similarity,
    (p.embedding <=> query_embedding) AS similarity_raw,
    p.synced_at::TIMESTAMPTZ
  FROM pinterest_pins p
  WHERE
    p.embedding IS NOT NULL
    AND (filter_board IS NULL OR p.board_name ILIKE '%' || filter_board || '%')
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_pinterest_pins(vector(384), INT, TEXT) TO anon;

-- Also ensure search_bookmarks_text is correct
DROP FUNCTION IF EXISTS search_bookmarks_text(TEXT, INT, TEXT);

CREATE OR REPLACE FUNCTION search_bookmarks_text(
  p_search_query TEXT,
  p_match_count INT DEFAULT 500,
  p_filter_folder TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  url TEXT,
  title TEXT,
  folder TEXT,
  chrome_id TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  query_lower TEXT;
BEGIN
  query_lower := LOWER(COALESCE(btrim(p_search_query), ''));

  -- Return empty if no query
  IF query_lower = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    b.id,
    b.url,
    b.title,
    b.folder,
    b.chrome_id,
    CASE
      WHEN LOWER(b.title) = query_lower THEN 1.0
      WHEN LOWER(b.title) LIKE '%' || query_lower || '%' THEN 0.8
      WHEN LOWER(COALESCE(b.folder, '')) LIKE '%' || query_lower || '%' THEN 0.6
      WHEN LOWER(b.url) LIKE '%' || query_lower || '%' THEN 0.4
      ELSE 0.3
    END::FLOAT AS similarity,
    b.created_at::TIMESTAMPTZ,
    b.updated_at::TIMESTAMPTZ
  FROM bookmarks b
  WHERE
    (p_filter_folder IS NULL OR b.folder ILIKE '%' || p_filter_folder || '%')
    AND (
      LOWER(b.title) LIKE '%' || query_lower || '%'
      OR LOWER(COALESCE(b.folder, '')) LIKE '%' || query_lower || '%'
      OR LOWER(b.url) LIKE '%' || query_lower || '%'
    )
  ORDER BY similarity DESC, b.updated_at DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_bookmarks_text(TEXT, INT, TEXT) TO anon;

-- Fix search_pinterest_pins_text
DROP FUNCTION IF EXISTS search_pinterest_pins_text(TEXT, INT, TEXT);

CREATE OR REPLACE FUNCTION search_pinterest_pins_text(
  search_query TEXT,
  match_count INT DEFAULT 500,
  filter_board TEXT DEFAULT NULL
)
RETURNS TABLE (
  pin_id TEXT,
  pin_url TEXT,
  title TEXT,
  description TEXT,
  image_url TEXT,
  board_name TEXT,
  similarity FLOAT,
  synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  query_lower TEXT;
BEGIN
  query_lower := LOWER(COALESCE(btrim(search_query), ''));

  -- Return empty if no query
  IF query_lower = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.pin_id,
    p.pin_url,
    p.title,
    p.description,
    p.image_url,
    p.board_name,
    CASE
      WHEN LOWER(COALESCE(p.title, '')) = query_lower THEN 1.0
      WHEN LOWER(COALESCE(p.title, '')) LIKE '%' || query_lower || '%' THEN 0.8
      WHEN LOWER(COALESCE(p.board_name, '')) LIKE '%' || query_lower || '%' THEN 0.6
      WHEN LOWER(COALESCE(p.description, '')) LIKE '%' || query_lower || '%' THEN 0.4
      ELSE 0.3
    END::FLOAT AS similarity,
    p.synced_at::TIMESTAMPTZ
  FROM pinterest_pins p
  WHERE
    (filter_board IS NULL OR p.board_name ILIKE '%' || filter_board || '%')
    AND (
      LOWER(COALESCE(p.title, '')) LIKE '%' || query_lower || '%'
      OR LOWER(COALESCE(p.board_name, '')) LIKE '%' || query_lower || '%'
      OR LOWER(COALESCE(p.description, '')) LIKE '%' || query_lower || '%'
    )
  ORDER BY similarity DESC, p.synced_at DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_pinterest_pins_text(TEXT, INT, TEXT) TO anon;
