-- The job abstraction, step 3 of plan dc_uwx045472m (grant gr_9mp6v6vv8k step 1): one job per piece of work. Read only for
-- now: core/src/jobs.ts back-fills it at boot from grants (rule ceiling), retainers (per-run), exploration chains (chunk),
-- directed sources (pocket) and one building job per building; nothing else writes it yet.
CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,             -- jb_<the lifecycle object's id>: jb_gr_…, jb_sc_…, jb_<chainId>, jb_<buildingId>_<sourceId>, jb_<buildingId>
  buildingId TEXT NOT NULL,
  goalId     TEXT,                         -- the grant's goal, else the building's
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('proposed', 'countered', 'open', 'held', 'closed')),
  closedAs   TEXT,                         -- done | cut | stopped | rejected | nothing-found | withdrawn; null while not closed
  rule       TEXT NOT NULL CHECK (rule IN ('chunk', 'ceiling', 'per-run', 'pocket', 'building')),
  pocketRef  TEXT,                         -- where its tokens come from: gr_…, sc_…, the chunk's reservation, the human source; null for a building job
  createdBy  TEXT NOT NULL,
  createdAt  TEXT NOT NULL
);
CREATE INDEX jobs_building ON jobs(buildingId, status);
CREATE INDEX jobs_pocket ON jobs(pocketRef);
