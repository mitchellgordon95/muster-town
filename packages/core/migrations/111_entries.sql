-- The job abstraction, step 1 (plan dc_uwx045472m §A1): a job's record is a thread of entries, one per session plus the
-- answers. Back-filled at boot by core jobs.ts from report docs (one entry each), report decisions and grant history;
-- nothing else writes it yet. `ref` is what an entry was read from (a report doc id, "<doc id>#decision",
-- "<grant id>#h<n>"), unique so the back-fill is idempotent. Additive: a new table.
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  -- fork | manager | human | secretary | code
  authorKind TEXT NOT NULL CHECK (authorKind IN ('fork', 'manager', 'human', 'secretary', 'code')),
  authorId TEXT,
  assignmentId TEXT,
  sessionId TEXT,
  -- the lifecycle object its tokens were drawn on (the job's pocketRef at the time)
  pocket TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  -- what moved: stepsDone, krClaimed, left, topUp, proposed, shipped[], action (JSON object)
  moved TEXT NOT NULL DEFAULT '{}',
  -- continue | pivot | stop | close | nothing (a session's entry); null on an answer
  proposes TEXT,
  -- the entry this one answers
  answers TEXT,
  -- who must answer it next: code | manager | human | none
  level TEXT NOT NULL DEFAULT 'none' CHECK (level IN ('code', 'manager', 'human', 'none')),
  note TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  ref TEXT UNIQUE,
  createdAt TEXT NOT NULL,
  UNIQUE (jobId, seq)
);
CREATE INDEX entries_job ON entries(jobId, seq);
CREATE INDEX entries_assignment ON entries(assignmentId);
