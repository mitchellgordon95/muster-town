-- The join funnel (grant gr_fibsfwr4tz step 3, findings dc_siqw9jf28w): how many strangers saw the guest card, signed in
-- with GitHub, asked to join, were let in or declined, per UTC day. Counts only: never a user id or login. Each world is
-- its own collective, so the day is the key; GET /api/join-funnel adds the collective's slug. Additive: two new tables,
-- back-filled from the events and access requests that already exist so the row is not empty on day one.
CREATE TABLE join_funnel (
  day TEXT PRIMARY KEY, guestCardViews INTEGER NOT NULL DEFAULT 0, signIns INTEGER NOT NULL DEFAULT 0,
  asked INTEGER NOT NULL DEFAULT 0, letIn INTEGER NOT NULL DEFAULT 0, declined INTEGER NOT NULL DEFAULT 0
);
-- one row per decision (let in or declined): how long the request waited, for the median wait
CREATE TABLE join_funnel_waits (day TEXT NOT NULL, waitMs INTEGER NOT NULL);
CREATE INDEX join_funnel_waits_day ON join_funnel_waits(day);

INSERT INTO join_funnel (day, signIns, asked, letIn, declined)
SELECT day, SUM(s), SUM(a), SUM(l), SUM(d) FROM (
  SELECT substr(ts, 1, 10) AS day, 1 AS s, 0 AS a, 0 AS l, 0 AS d FROM events WHERE type = 'system' AND text LIKE '% signed in with GitHub (@%'
  UNION ALL SELECT substr(createdAt, 1, 10), 0, 1, 0, 0 FROM access_requests
  UNION ALL SELECT substr(decidedAt, 1, 10), 0, 0, 1, 0 FROM access_requests WHERE status = 'granted' AND decidedAt IS NOT NULL
  UNION ALL SELECT substr(decidedAt, 1, 10), 0, 0, 0, 1 FROM access_requests WHERE status = 'declined' AND decidedAt IS NOT NULL
) GROUP BY day;
INSERT INTO join_funnel_waits (day, waitMs)
SELECT substr(decidedAt, 1, 10), CAST(ROUND((julianday(decidedAt) - julianday(createdAt)) * 86400000) AS INTEGER)
FROM access_requests WHERE decidedAt IS NOT NULL AND status IN ('granted', 'declined');
