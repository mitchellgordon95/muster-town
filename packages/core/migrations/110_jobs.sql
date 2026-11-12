-- The job abstraction, step 1 (plan dc_uwx045472m §A1, grant gr_9mp6v6vv8k): every piece of work is a job with one
-- budget rule. Read only for now: core jobs.ts back-fills it at boot from grants (rule ceiling), schedules (per-run),
-- exploration chunks (chunk), directed sources (pocket) and one job per building (building); nothing else writes it yet.
-- Additive: a new table.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  buildingId TEXT NOT NULL,
  goalId TEXT,
  title TEXT NOT NULL,
  -- proposed | countered | open | held | closed
  status TEXT NOT NULL CHECK (status IN ('proposed', 'countered', 'open', 'held', 'closed')),
  -- done | cut | stopped | rejected | nothing-found | withdrawn; null unless closed
  closedAs TEXT,
  -- the budget rule that replaces the lane: chunk | ceiling | per-run | pocket | building
  rule TEXT NOT NULL CHECK (rule IN ('chunk', 'ceiling', 'per-run', 'pocket', 'building')),
  -- the lifecycle object it reads its money from: a grant (gr_), a schedule (sc_), a reservation or chain (chunk),
  -- the human source (pocket), the building id (building)
  pocketRef TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (buildingId, rule, pocketRef)
);
CREATE INDEX jobs_ref ON jobs(pocketRef);
CREATE INDEX jobs_building ON jobs(buildingId, status);
