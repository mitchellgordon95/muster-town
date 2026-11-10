-- Legible Delegation step 5 (docs/legible-delegation.md §8): notices, a state change with nothing to do. Kinds: shipped,
-- closed-loop, verified, slate, pattern, gate. refs is a JSON array of the ids it is about. Additive: a new table.
CREATE TABLE notices (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, buildingId TEXT, goalId TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  picture TEXT, refs TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
);
CREATE INDEX notices_created ON notices(createdAt);
CREATE INDEX notices_kind ON notices(kind, createdAt);
CREATE INDEX notices_building ON notices(buildingId, createdAt);
