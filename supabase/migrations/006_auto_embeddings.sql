-- Migration: Auto-generate embeddings on insert/update
-- Uses pg_net extension to call the Edge Function

-- Enable pg_net extension (for HTTP requests from database)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Function to generate embedding via Edge Function
CREATE OR REPLACE FUNCTION generate_embedding_for_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  text_content TEXT;
  edge_function_url TEXT;
  service_role_key TEXT;
BEGIN
  -- Get the Supabase URL from environment (set in Supabase dashboard)
  edge_function_url := current_setting('app.settings.edge_function_url', true);
  service_role_key := current_setting('app.settings.service_role_key', true);

  -- If settings not configured, skip (will need manual embedding generation)
  IF edge_function_url IS NULL OR service_role_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build text content based on table
  IF TG_TABLE_NAME = 'bookmarks' THEN
    text_content := COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.folder, '') || ' ' || COALESCE(NEW.url, '');
  ELSIF TG_TABLE_NAME = 'pinterest_pins' THEN
    text_content := COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.board_name, '');
  ELSE
    RETURN NEW;
  END IF;

  -- Only generate if embedding is null and we have text content
  IF NEW.embedding IS NULL AND length(trim(text_content)) > 0 THEN
    -- Queue async HTTP request to Edge Function
    PERFORM net.http_post(
      url := edge_function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_role_key
      ),
      body := jsonb_build_object(
        'text', text_content,
        'table', TG_TABLE_NAME,
        'id', NEW.id::text
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Create triggers for bookmarks table
DROP TRIGGER IF EXISTS trigger_generate_bookmark_embedding ON bookmarks;
CREATE TRIGGER trigger_generate_bookmark_embedding
  AFTER INSERT ON bookmarks
  FOR EACH ROW
  WHEN (NEW.embedding IS NULL)
  EXECUTE FUNCTION generate_embedding_for_row();

-- Create triggers for pinterest_pins table
DROP TRIGGER IF EXISTS trigger_generate_pin_embedding ON pinterest_pins;
CREATE TRIGGER trigger_generate_pin_embedding
  AFTER INSERT ON pinterest_pins
  FOR EACH ROW
  WHEN (NEW.embedding IS NULL)
  EXECUTE FUNCTION generate_embedding_for_row();

-- Grant permissions
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

COMMENT ON FUNCTION generate_embedding_for_row IS 'Automatically generates embeddings for new rows by calling the Edge Function';
