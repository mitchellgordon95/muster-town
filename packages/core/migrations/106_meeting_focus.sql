-- The item open on a 1:1's human's screen in the Town Hall decision queue (Mitchell 2026-11-09: "the secretary should
-- know what's open"): {kind, id, at} as JSON, set by PUT /api/meetings/:id/focus, NULL when nothing is open.
ALTER TABLE meetings ADD COLUMN focus TEXT;
