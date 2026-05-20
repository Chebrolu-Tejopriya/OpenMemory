-- Insight RPC functions for Home Widgets
-- Cached 24hr on backend — minimal egress impact

-- Top bookmark folder by total count (excludes OM-saved links)
CREATE OR REPLACE FUNCTION get_top_folder()
RETURNS TABLE(name TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT folder AS name, COUNT(*) AS count
  FROM bookmarks
  WHERE folder IS NOT NULL
    AND folder IS DISTINCT FROM 'OM'
  GROUP BY folder
  ORDER BY count DESC
  LIMIT 1;
$$;

-- Top Pinterest board by total pin count
CREATE OR REPLACE FUNCTION get_top_board()
RETURNS TABLE(name TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT board_name AS name, COUNT(*) AS count
  FROM pinterest_pins
  WHERE board_name IS NOT NULL
  GROUP BY board_name
  ORDER BY count DESC
  LIMIT 1;
$$;

-- Save velocity: total saves last 7 days vs previous 7 days (bookmarks + notes + links)
CREATE OR REPLACE FUNCTION get_save_velocity()
RETURNS TABLE(this_week BIGINT, last_week BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS this_week,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days'
                       AND created_at <  NOW() - INTERVAL '7 days')  AS last_week
  FROM (
    SELECT created_at FROM bookmarks
    UNION ALL
    SELECT created_at FROM sticky_notes
  ) combined;
$$;

GRANT EXECUTE ON FUNCTION get_top_folder()     TO anon;
GRANT EXECUTE ON FUNCTION get_top_board()      TO anon;
GRANT EXECUTE ON FUNCTION get_save_velocity()  TO anon;
