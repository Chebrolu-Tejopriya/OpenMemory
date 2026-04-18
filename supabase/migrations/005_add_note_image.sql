-- Store base64-compressed image data directly in the note row
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS image_data TEXT;
