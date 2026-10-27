-- Backfill assignments.chainId (048): the first assignment of the chain. An assignment continues the one it was retried
-- from (fromAssignmentId), else the one whose report it follows (fromReportId: a park continuation, a review
-- continue/redirect). Roots (no parent, a parent that no longer exists, or itself) are their own chain. Re-runnable.
WITH RECURSIVE parent(id, pid) AS (
  SELECT a.id, COALESCE(a.fromAssignmentId, (SELECT d.assignmentId FROM docs d WHERE d.id = a.fromReportId)) FROM assignments a
), chain(id, root, depth) AS (
  SELECT p.id, p.id, 0 FROM parent p WHERE p.pid IS NULL OR p.pid = p.id OR NOT EXISTS (SELECT 1 FROM assignments x WHERE x.id = p.pid)
  UNION ALL
  SELECT p.id, c.root, c.depth + 1 FROM parent p JOIN chain c ON p.pid = c.id WHERE p.pid != p.id AND c.depth < 10000
)
UPDATE assignments SET chainId = (SELECT root FROM chain WHERE chain.id = assignments.id);
-- a cycle has no root: each of its assignments starts its own chain
UPDATE assignments SET chainId = id WHERE chainId IS NULL;
