-- Schedules step 2 (Mitchell, 1:1 mt_w7z9k1z112: "let's get repeats working"): a schedule can be paused (it keeps its
-- next run but does not fire until resumed) and a repeat can end after a number of runs as well as at a date.
ALTER TABLE schedules ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
-- a repeat ends once it has fired this many times (null = only endsAt ends it)
ALTER TABLE schedules ADD COLUMN maxRuns INTEGER CHECK (maxRuns IS NULL OR maxRuns >= 1);
