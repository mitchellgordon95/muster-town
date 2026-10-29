-- Building schedules (Mitchell, 1:1 mt_w7z9k1z112; design docs/scheduling.md): a timed job lives on its building, not on
-- an agent. When it fires (the runtime tick, next to checkWaits) it creates ONE normal assignment and hands it to whoever
-- is around: the building queue when forks are on, else an idle resident, else the manager. One-shot (no repeat) or
-- repeating every N minutes or at fixed UTC times of day, until endsAt. Missed fires during downtime collapse into one.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  buildingId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  -- the next (or only) run; null once it has ended
  nextRunAt TEXT,
  -- the repeat: at most one of everyMinutes (>= 60) and dailyAt (JSON array of "HH:MM" UTC); neither = one-shot
  everyMinutes INTEGER CHECK (everyMinutes IS NULL OR everyMinutes >= 60),
  dailyAt TEXT,
  -- a repeating schedule always ends (default 14 days out, at most 90), so nothing recurs unattended forever
  endsAt TEXT,
  -- lane fields, as on assignments (LaneFields): checked when it is made and again at every fire
  lane TEXT, grantId TEXT, keyResultId TEXT, gap TEXT, sourceId TEXT,
  -- topic pages for a fork's memory (JSON array of doc ids, at most 3) and the fork's model (null = the building's)
  pages TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  -- the human it traces to (wakes step 1), copied onto every assignment it creates
  origin TEXT,
  -- active | ended (ran its one shot, past endsAt, cancelled, or its lane no longer holds: endedReason says which)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  endedReason TEXT,
  lastRunAt TEXT,
  -- the assignment the last fire created: while it is still pending the next fire is skipped (no pile-up)
  lastAssignmentId TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  createdBy TEXT NOT NULL,
  createdByKind TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK (everyMinutes IS NULL OR dailyAt IS NULL)
);
CREATE INDEX schedules_due ON schedules(status, nextRunAt);
CREATE INDEX schedules_building ON schedules(buildingId, status);
