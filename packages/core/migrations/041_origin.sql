-- Wakes step 1 (docs/wakes.md): the human a chain of work traces to, {userId, via, hops, at} as JSON; null = none.
ALTER TABLE messages ADD COLUMN origin TEXT;
ALTER TABLE assignments ADD COLUMN origin TEXT;
ALTER TABLE sessions ADD COLUMN origin TEXT;
