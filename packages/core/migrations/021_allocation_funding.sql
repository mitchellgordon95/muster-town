-- funding: allocations say how their sessions authenticate, carry a label, and can be retired (kept for history)
ALTER TABLE allocations ADD COLUMN auth TEXT NOT NULL DEFAULT 'api-key';
ALTER TABLE allocations ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE allocations ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
-- an existing allocation whose donor stored a key ran on that key
UPDATE allocations SET auth = 'donor-key' WHERE userId IN (SELECT id FROM users WHERE apiKey IS NOT NULL AND apiKey != '');
ALTER TABLE sessions ADD COLUMN funding TEXT;
