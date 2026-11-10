-- Legible Delegation step 3 (docs/legible-delegation.md §5, §11): what each signed-in human has opened, so an ask's card
-- is written as a diff against what its reader has seen (core seen.ts `readerDelta`). One row per human and target,
-- `at` the last time they opened it. Agents never write rows. targetKind: report (a doc), grant, ask.
CREATE TABLE seen (
  userId TEXT NOT NULL, targetKind TEXT NOT NULL, targetId TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (userId, targetKind, targetId)
);
-- an ask filed although its card failed its type's contract or the linter carries the tag "lint-failed" (asks.ts)
ALTER TABLE asks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
