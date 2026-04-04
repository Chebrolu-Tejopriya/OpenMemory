-- Migration: Improve search with better query understanding and bookmark prioritization
-- Adds missing search_bookmarks_text function and improves search_all_items

-- First, drop the existing function(s) to avoid ambiguity
DROP FUNCTION IF EXISTS search_all_items(vector, TEXT, BOOLEAN, INT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS search_all_items(vector(384), TEXT, BOOLEAN, INT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.search_all_items(vector, TEXT, BOOLEAN, INT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.search_all_items(vector(384), TEXT, BOOLEAN, INT, TEXT, TEXT, TEXT);

-- CREATE search_bookmarks_text function (was missing!)
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
    b.created_at,
    b.updated_at
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

-- Recreate the search_all_items function with improvements
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
DECLARE
  query_terms TEXT[];
  query_lower TEXT;
BEGIN
  -- Preprocess query: lowercase and split into terms
  query_lower := LOWER(COALESCE(btrim(search_query), ''));
  query_terms := string_to_array(query_lower, ' ');

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
        AND (filter_folder IS NULL OR b.folder ILIKE '%' || filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'all' OR filter_source = 'chrome')
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
        AND (filter_folder IS NULL OR p.board_name ILIKE '%' || filter_folder || '%')
        AND (filter_source IS NULL OR filter_source = 'all' OR filter_source = 'pinterest')
        AND (filter_board IS NULL OR p.board_name ILIKE '%' || filter_board || '%')
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
      -- Improved keyword scoring: check multiple terms
      CASE
        WHEN query_lower = '' THEN 0
        -- Exact title match (highest)
        WHEN LOWER(combined.title) = query_lower THEN 1.0
        -- Title contains full query
        WHEN LOWER(combined.title) LIKE '%' || query_lower || '%' THEN 0.8
        -- All query terms found in title
        WHEN (
          SELECT COUNT(*) FROM unnest(query_terms) AS term
          WHERE LOWER(combined.title) LIKE '%' || term || '%'
        ) = array_length(query_terms, 1) THEN 0.7
        -- Most query terms found in title (>50%)
        WHEN (
          SELECT COUNT(*) FROM unnest(query_terms) AS term
          WHERE LOWER(combined.title) LIKE '%' || term || '%'
        )::FLOAT / GREATEST(array_length(query_terms, 1), 1) > 0.5 THEN 0.5
        -- Folder/board contains query
        WHEN LOWER(COALESCE(combined.folder_or_board, '')) LIKE '%' || query_lower || '%' THEN 0.4
        -- Any term found in title
        WHEN EXISTS (
          SELECT 1 FROM unnest(query_terms) AS term
          WHERE LOWER(combined.title) LIKE '%' || term || '%'
        ) THEN 0.3
        -- URL contains query terms
        WHEN LOWER(combined.url) LIKE '%' || query_lower || '%' THEN 0.2
        ELSE 0
      END AS keyword_score,
      -- Recency score (decay over 30 days)
      CASE
        WHEN combined.created_at IS NULL THEN 0.5 -- neutral for items without date
        ELSE GREATEST(
          0,
          1 - LEAST(EXTRACT(EPOCH FROM (NOW() - combined.created_at)) / 2592000.0, 1)
        )
      END AS recency_score,
      -- Normalized vector similarity (0-1)
      CASE
        WHEN stats.max_raw IS NULL OR stats.min_raw IS NULL OR stats.max_raw = stats.min_raw THEN
          GREATEST(0, LEAST(1, 1 - (combined.similarity_raw / 2.0)))
        ELSE
          GREATEST(0, LEAST(1, 1 - ((combined.similarity_raw - stats.min_raw) / NULLIF(stats.max_raw - stats.min_raw, 0))))
      END AS similarity,
      -- Source boost: bookmarks get priority
      CASE
        WHEN combined.source = 'chrome' THEN 1.0
        ELSE 0.0
      END AS source_boost
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
      ELSE
        -- New scoring formula with bookmark boost:
        -- 25% vector + 40% keyword + 15% recency + 20% source boost
        (0.25 * scored.similarity) +
        (0.40 * scored.keyword_score) +
        (0.15 * scored.recency_score) +
        (0.20 * scored.source_boost)
    END AS final_score,
    scored.created_at
  FROM scored
  ORDER BY
    -- PRIMARY: bookmarks ALWAYS come first
    CASE WHEN scored.source = 'chrome' THEN 0 ELSE 1 END ASC,
    -- SECONDARY: sort by score within each source group
    CASE WHEN use_vector_only THEN scored.similarity_raw ELSE NULL END ASC,
    final_score DESC
  LIMIT match_count;
END;
$$;

-- Also create a helper function for query expansion (synonyms)
CREATE OR REPLACE FUNCTION expand_search_query(
  original_query TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  expanded TEXT;
  query_lower TEXT;
BEGIN
  query_lower := LOWER(btrim(original_query));
  expanded := query_lower;

  -- Common design-related synonyms
  IF query_lower LIKE '%dashboard%' THEN
    expanded := expanded || ' admin panel analytics';
  END IF;

  IF query_lower LIKE '%ui%' OR query_lower LIKE '%user interface%' THEN
    expanded := expanded || ' design interface ux';
  END IF;

  IF query_lower LIKE '%button%' THEN
    expanded := expanded || ' cta action';
  END IF;

  IF query_lower LIKE '%landing%' THEN
    expanded := expanded || ' homepage hero';
  END IF;

  IF query_lower LIKE '%mobile%' THEN
    expanded := expanded || ' app ios android responsive';
  END IF;

  IF query_lower LIKE '%dark%' THEN
    expanded := expanded || ' night mode theme';
  END IF;

  IF query_lower LIKE '%card%' THEN
    expanded := expanded || ' tile component';
  END IF;

  IF query_lower LIKE '%form%' THEN
    expanded := expanded || ' input field';
  END IF;

  IF query_lower LIKE '%nav%' OR query_lower LIKE '%menu%' THEN
    expanded := expanded || ' navigation sidebar header';
  END IF;

  IF query_lower LIKE '%fintech%' OR query_lower LIKE '%finance%' THEN
    expanded := expanded || ' banking payment crypto';
  END IF;

  RETURN expanded;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION expand_search_query(TEXT) TO anon;

COMMENT ON FUNCTION search_all_items IS 'Enhanced search with multi-term matching and bookmark prioritization. Scoring: 25% vector + 40% keyword + 15% recency + 20% source boost (bookmarks)';
