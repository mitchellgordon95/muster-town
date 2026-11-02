-- Retainer runs that came due with nothing usable to run on are missed, not queued (docs/bank.md "Retainers: lookahead
-- and missed runs", Mitchell 2026-11-01). The current streak of missed runs and when it began; a run that fires resets it.
ALTER TABLE schedules ADD COLUMN missedRuns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN missedSince TEXT;
