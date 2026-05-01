-- Enable pgvector extension for embedding similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Create bookmarks table with URL as unique key
CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  folder TEXT,
  chrome_id TEXT,
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_chrome_id ON bookmarks(chrome_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder);
CREATE INDEX IF NOT EXISTS idx_bookmarks_updated_at ON bookmarks(updated_at);

-- Create HNSW index for fast vector similarity search
CREATE INDEX IF NOT EXISTS idx_bookmarks_embedding ON bookmarks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Function to search bookmarks by vector similarity
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
    b.created_at,
    b.updated_at
  FROM bookmarks b
  WHERE
    b.embedding IS NOT NULL
    AND (filter_folder IS NULL OR b.folder ILIKE filter_folder || '%')
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Enable Row Level Security (optional, can be enabled later)
-- ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_bookmarks_updated_at
  BEFORE UPDATE ON bookmarks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions for anon role (for Supabase auth)
GRANT SELECT, INSERT, UPDATE, DELETE ON bookmarks TO anon;
GRANT USAGE ON SCHEMA public TO anon;
