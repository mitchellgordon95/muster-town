-- Build step 3 of docs/how-work-gets-done.md (§3, doc §11 step 2; 1:1 mt_wql34b8gkl): exploration is declarative. The
-- rule lives on the goal and is inherited down the tree (null = inherit; the root's nulls mean on / 100,000 tokens):
-- the runtime tick reserves one chunk (bank_reservations, migration 067) and queues one explorer on the building's queue.
-- Additive: nullable columns, no back-fill.
ALTER TABLE goals ADD COLUMN explore INTEGER;
ALTER TABLE goals ADD COLUMN exploreChunkTokens INTEGER;
ALTER TABLE assignments ADD COLUMN reservationId TEXT;
CREATE INDEX bank_reservations_assignment ON bank_reservations(assignmentId);
