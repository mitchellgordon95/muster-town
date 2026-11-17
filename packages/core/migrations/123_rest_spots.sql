-- Drag only the body (Mitchell's flag dc_d2wkuhoh1l): where an agent rests when it is not working elsewhere, set by a
-- human dropping it with the grasper hand. Additive: one row per agent that has been moved; no row = the default spot
-- (its desk's stand tile, or the Town Hall rest by the hydrant / goal tree). buildingId set: x, y are relative to that
-- building's lot, so the spot follows the building when the map redraws; null: x, y are absolute town tiles.
CREATE TABLE IF NOT EXISTS rest_spots (
  agentId TEXT PRIMARY KEY,
  buildingId TEXT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  updatedAt TEXT NOT NULL
);
