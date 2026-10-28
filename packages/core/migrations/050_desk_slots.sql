-- Manager forks step 3 (design note dc_mymt27yz25 §2.5, §8.3): a fork's desk sandbox belongs to the desk slot, not the
-- agent. One row per (building, desk n) once a fork has used it: the sandbox (Machine or container) name and the home
-- volume. The runtime writes the default names (desk-<collective>-<building>-<n>, deskhome-<building>-<n>) on first use;
-- pointing volumeName at a resident's deskhome-<agentId> adopts that home (step 7). Named residents keep per-agent desks.
CREATE TABLE desk_slots (
  buildingId TEXT NOT NULL, n INTEGER NOT NULL, sandboxName TEXT NOT NULL, volumeName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (buildingId, n)
);
