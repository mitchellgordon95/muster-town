-- The job abstraction, step 3 of plan dc_uwx045472m: a job's thread. One entry per session report, plus the answers to it
-- (a manager's review, a human's grant or retainer decision). Read only for now: back-filled at boot by core/src/jobs.ts.
CREATE TABLE entries (
  id           TEXT PRIMARY KEY,           -- back-filled: en_<report doc id> (en_dc_…), en_ev<event id>, en_<grant id>_h<history index>
  jobId        TEXT NOT NULL,
  seq          INTEGER NOT NULL,           -- 1, 2, 3… in the job's thread
  authorKind   TEXT NOT NULL CHECK (authorKind IN ('fork', 'manager', 'human', 'secretary', 'code')),
  authorId     TEXT NOT NULL,
  assignmentId TEXT,
  sessionId    TEXT,
  pocket       TEXT,                       -- the pocket its tokens drew on (the job's pocketRef when back-filled)
  tokens       INTEGER NOT NULL DEFAULT 0,
  moved        TEXT NOT NULL DEFAULT '{}', -- JSON: stepsDone, krClaimed, left, topUp, proposed, shipped; back-filled answers carry decision / action
  proposes     TEXT,                       -- continue | pivot | stop | close | nothing
  answers      TEXT,                       -- the entry it answers
  level        TEXT NOT NULL DEFAULT 'none' CHECK (level IN ('code', 'manager', 'human', 'none')),
  note         TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',   -- a report entry: the report's body (its doc stays the record until step 9b)
  docId        TEXT,                       -- the doc it was back-filled from (a report, or the report a decision answers)
  createdAt    TEXT NOT NULL,
  UNIQUE (jobId, seq)
);
CREATE INDEX entries_job ON entries(jobId, seq);
CREATE INDEX entries_answers ON entries(answers);
