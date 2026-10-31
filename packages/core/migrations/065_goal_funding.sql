-- Pool and exploration budget move from the building to the goal it is attached to (1:1 mt_n25udpflus decision 3, part 1;
-- docs/goals.md "Pool and exploration budget on the goal"). A building's pool / allowance = the nearest ancestor-or-self goal
-- of its attachment that sets one (core/src/goals.ts `fundingOf`). Additive: buildings.poolId and
-- buildings.explorationTokensPerDay stay in place but nothing reads them after this.
ALTER TABLE goals ADD COLUMN poolId TEXT;
ALTER TABLE goals ADD COLUMN explorationTokensPerDay INTEGER;

-- back-fill from the labs (the Town Hall keeps its special case): the first building by createdAt on a goal wins
UPDATE goals SET poolId = (SELECT b.poolId FROM buildings b WHERE b.goalId = goals.id AND b.kind != 'town-hall' AND b.poolId IS NOT NULL ORDER BY b.createdAt, b.rowid LIMIT 1)
  WHERE poolId IS NULL;
UPDATE goals SET explorationTokensPerDay = (SELECT b.explorationTokensPerDay FROM buildings b WHERE b.goalId = goals.id AND b.kind != 'town-hall' AND b.explorationTokensPerDay IS NOT NULL ORDER BY b.createdAt, b.rowid LIMIT 1)
  WHERE explorationTokensPerDay IS NULL;

-- the goal's History shows what moved onto it
INSERT INTO events (ts, type, text, payload)
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'goal.edited',
    'Funding moved here from its building: ' || trim(CASE WHEN g.poolId IS NULL THEN '' ELSE 'pool ' || COALESCE((SELECT name FROM bank_pools WHERE id = g.poolId), g.poolId) END
      || CASE WHEN g.explorationTokensPerDay IS NULL THEN '' ELSE ' exploration ' || g.explorationTokensPerDay || ' tokens/day' END),
    json_object('goalId', g.id, 'poolId', g.poolId, 'explorationTokensPerDay', g.explorationTokensPerDay, 'backfill', 1)
  FROM goals g WHERE g.poolId IS NOT NULL OR g.explorationTokensPerDay IS NOT NULL;

-- the migration's output: a building on the same goal that disagreed (its value was not kept)
INSERT INTO events (ts, type, buildingId, text, payload)
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bank.pool', b.id,
    b.name || ' disagreed with its goal''s back-filled funding (pool ' || COALESCE(b.poolId, '-') || ', exploration ' || COALESCE(b.explorationTokensPerDay, '-') || '); the goal kept pool ' || COALESCE(g.poolId, '-') || ', exploration ' || COALESCE(g.explorationTokensPerDay, '-'),
    json_object('goalId', g.id, 'buildingId', b.id, 'poolId', b.poolId, 'explorationTokensPerDay', b.explorationTokensPerDay, 'backfillConflict', 1)
  FROM buildings b JOIN goals g ON g.id = b.goalId
  WHERE b.kind != 'town-hall' AND ((b.poolId IS NOT NULL AND b.poolId != g.poolId) OR (b.explorationTokensPerDay IS NOT NULL AND b.explorationTokensPerDay != g.explorationTokensPerDay));
