-- Media in reports (docs/multimedia.md): screenshots, short videos and generated images an agent uploads from its desk
-- (POST /api/media) and cites in a doc's markdown as ![caption](/api/media/<id>.<ext>). The bytes live in the town
-- database, so the nightly backup carries them and a redeploy never loses one.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,      -- mf_ + 10 lowercase alphanumerics
  mime TEXT NOT NULL,       -- image/png | image/jpeg | image/gif | image/webp | video/webm | video/mp4
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  authorId TEXT NOT NULL,   -- the agent (or a user's avatar) that uploaded it
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_author ON media (authorId, createdAt);
CREATE INDEX IF NOT EXISTS media_sha ON media (sha256);
