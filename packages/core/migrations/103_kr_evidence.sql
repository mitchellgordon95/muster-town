-- Legible Delegation step 10 (docs/legible-delegation.md §5 "A town dictionary"): a key result's evidence class beside
-- its status: verified (a human marked it met, or a kr claim check the server ran passed), claimed (a fork's report or
-- the manager says so), unknown. Back-fill: met → verified, claimed → claimed; the rest stay unknown. A NULL (a row
-- written without it) reads as unknown (schema KeyResult.evidence is optional).
ALTER TABLE key_results ADD COLUMN evidence TEXT DEFAULT 'unknown';
UPDATE key_results SET evidence = 'verified' WHERE status = 'met';
UPDATE key_results SET evidence = 'claimed' WHERE status = 'claimed';
