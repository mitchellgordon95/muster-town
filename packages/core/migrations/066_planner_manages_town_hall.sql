-- The Planner is the Town Hall's manager (Mitchell, 1:1 mt_wql34b8gkl): back-fill buildings.managerAgentId on the Town
-- Hall from the existing Planner (the first live Town Hall resident titled "Planner", as core Reorgs.planner() picks it).
-- Additive: a Town Hall that already names a manager, or has no Planner yet, is left alone (ensurePlanner sets it on first use).
UPDATE buildings SET managerAgentId = (
    SELECT a.id FROM agents a
    WHERE a.homeBuildingId = buildings.id AND a.kind = 'resident' AND a.title = 'Planner' AND a.forkOf IS NULL
      AND a.status NOT IN ('banned', 'retired')
    ORDER BY a.createdAt LIMIT 1)
  WHERE kind = 'town-hall' AND managerAgentId IS NULL;
