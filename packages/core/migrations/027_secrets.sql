-- Collective secrets (docs/secrets.md): a name, its value encrypted with AES-256-GCM under the host's
-- MUSTER_TOWN_DATA_KEY (never stored here), and who it is granted to (JSON: buildings, agents, skills).
CREATE TABLE secrets (
  name TEXT PRIMARY KEY, ciphertext TEXT, grants TEXT NOT NULL DEFAULT '{}', updatedAt TEXT NOT NULL, updatedBy TEXT
);
