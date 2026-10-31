-- Desks a desk-image redeploy found busy and so left on the old image (1:1 mt_cvxnqawx7h, 2026-10-31). The runtime removes
-- each one's Machine (home volume kept) once no session is on it, so its next session starts on a fresh one from the new image.
-- key: the resident's agent id, or a fork desk slot's sandbox name (then buildingId and n name the slot).
CREATE TABLE IF NOT EXISTS stale_desks (
  key TEXT PRIMARY KEY,
  buildingId TEXT,
  n INTEGER,
  at TEXT NOT NULL
);
