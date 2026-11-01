-- 1:1 mt_cyd2t5ioob decision 1: the Bank books every charge in one standard accounting model's output tokens (Opus 5.5).
-- The model a session is booked in: 'claude-opus-5-5' for every session started from now on.
-- NULL = a session from before this migration, booked (and kept) in its own model's output tokens.
ALTER TABLE sessions ADD COLUMN bankModel TEXT;
