-- Scheduled work step 2 (Mitchell, town hall mt_xywhisvdcm decision 10; design docs/scheduling.md): a building-owned
-- recurring schedule. Each time it fires (the runtime tick, next to checkWaits) it creates ONE assignment on the building
-- queue with the stored title, description, lane fields, pages and model, then moves nextRunAt to the next occurrence
-- after now (missed fires during downtime collapse into one). Exactly one of cron / everyMinutes is set.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  buildingId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  -- the recurrence: a 5-field cron expression in UTC ("0 20 * * *") or a fixed interval in minutes (every N hours = N*60)
  cron TEXT,
  everyMinutes INTEGER CHECK (everyMinutes IS NULL OR everyMinutes >= 60),
  -- lane fields, as on assignments (LaneFields): directed needs sourceId = the human source the schedule traces to
  lane TEXT, grantId TEXT, keyResultId TEXT, gap TEXT, sourceId TEXT,
  -- topic pages for the fork's memory (JSON array of doc ids, at most 3) and the model (null = the building's)
  pages TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  -- active | paused | ended (cancelled by a human or the manager, past endsAt, or its lane no longer holds)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  endedReason TEXT,
  nextRunAt TEXT,
  lastRunAt TEXT,
  -- the assignment the last fire created: while it is still pending the next fire is skipped (no pile-up)
  lastAssignmentId TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  -- every schedule ends: endsAt is required (default 14 days out, at most 90), so nothing recurs unattended forever
  endsAt TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdByKind TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK ((cron IS NULL) <> (everyMinutes IS NULL))
);
CREATE INDEX schedules_due ON schedules(status, nextRunAt);
CREATE INDEX schedules_building ON schedules(buildingId, status);
