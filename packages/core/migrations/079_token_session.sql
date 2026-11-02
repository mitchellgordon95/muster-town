-- gr_6qlj35wnh3 step 3 (docs/secrets.md "Login tokens"): login tokens are stored as sha256 hashes (the boot back-fill
-- in core/src/db.ts hashes the plaintext rows; SQLite has no sha256), and an agent gets a token per session, revoked
-- when the session ends. Additive: old rows keep a null sessionId and keep working.
ALTER TABLE tokens ADD COLUMN sessionId TEXT;
CREATE INDEX tokens_session ON tokens(sessionId);
