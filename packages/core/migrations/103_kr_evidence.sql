-- Legible Delegation step 10 (docs/legible-delegation.md §5 "A town dictionary"): a key result's evidence class beside
-- its status: verified (a human marked it met, or a kr claim check the server ran passed), claimed (a fork's report or
-- the manager says so), unknown. Back-fill: met by a human (statusBy a user id, us_…) → verified; met by anyone else
-- (a manager's close_grant marks its open key results met) and claimed → claimed; the rest stay unknown. A NULL (a row
-- written without it) reads as unknown (schema KeyResult.evidence is optional).
ALTER TABLE key_results ADD COLUMN evidence TEXT DEFAULT 'unknown';
UPDATE key_results SET evidence = 'verified' WHERE status = 'met' AND statusBy LIKE 'us\_%' ESCAPE '\';
UPDATE key_results SET evidence = 'claimed' WHERE status = 'claimed' OR (status = 'met' AND (statusBy IS NULL OR statusBy NOT LIKE 'us\_%' ESCAPE '\'));
