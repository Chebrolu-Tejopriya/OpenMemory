-- Add todos column to sticky_notes for checklist support
-- Stored as JSON array: [{ id: string, text: string, done: boolean }]
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS todos TEXT DEFAULT NULL;
