-- Add free-form position columns to sticky_notes for draggable canvas
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS pos_x FLOAT;
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS pos_y FLOAT;
