-- Activity RPC functions for Home Widgets
-- Returns {date, count}[] for the last 30 days per data type
-- All functions are cached 24hr on the backend — designed for low egress

-- ── Bookmark activity (excludes OM-saved links) ──────────────────────────────
CREATE OR REPLACE FUNCTION get_bookmark_activity()
RETURNS TABLE(date DATE, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT created_at::date AS date, COUNT(*) AS count
  FROM bookmarks
  WHERE folder IS DISTINCT FROM 'OM'
    AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
  ORDER BY date ASC;
$$;

-- ── Pinterest pin activity ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_pin_activity()
RETURNS TABLE(date DATE, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT synced_at::date AS date, COUNT(*) AS count
  FROM pinterest_pins
  WHERE synced_at >= NOW() - INTERVAL '30 days'
  GROUP BY synced_at::date
  ORDER BY date ASC;
$$;

-- ── Note activity ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_note_activity()
RETURNS TABLE(date DATE, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT created_at::date AS date, COUNT(*) AS count
  FROM sticky_notes
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
  ORDER BY date ASC;
$$;

-- ── OM link activity (folder = 'OM') ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_link_activity()
RETURNS TABLE(date DATE, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT created_at::date AS date, COUNT(*) AS count
  FROM bookmarks
  WHERE folder = 'OM'
    AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY created_at::date
  ORDER BY date ASC;
$$;

-- ── Total count functions (COUNT only, no row fetching) ───────────────────────
CREATE OR REPLACE FUNCTION get_bookmark_count()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*) FROM bookmarks WHERE folder IS DISTINCT FROM 'OM';
$$;

CREATE OR REPLACE FUNCTION get_pin_count()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*) FROM pinterest_pins;
$$;

CREATE OR REPLACE FUNCTION get_note_count()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*) FROM sticky_notes;
$$;

CREATE OR REPLACE FUNCTION get_link_count()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*) FROM bookmarks WHERE folder = 'OM';
$$;

-- Grant execute to anon role (matches existing RLS setup)
GRANT EXECUTE ON FUNCTION get_bookmark_activity() TO anon;
GRANT EXECUTE ON FUNCTION get_pin_activity() TO anon;
GRANT EXECUTE ON FUNCTION get_note_activity() TO anon;
GRANT EXECUTE ON FUNCTION get_link_activity() TO anon;
GRANT EXECUTE ON FUNCTION get_bookmark_count() TO anon;
GRANT EXECUTE ON FUNCTION get_pin_count() TO anon;
GRANT EXECUTE ON FUNCTION get_note_count() TO anon;
GRANT EXECUTE ON FUNCTION get_link_count() TO anon;
