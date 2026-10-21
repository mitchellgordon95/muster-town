-- Skills (docs/skills.md): a skill is a doc of type 'skill' (its body is SKILL.md); this adds its bundled files,
-- the pins that put skills into sessions, and an index for counting skill.used events.
CREATE TABLE skill_files (
  skillId TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, updatedAt TEXT NOT NULL,
  PRIMARY KEY (skillId, path)
);
CREATE TABLE skill_pins (
  id TEXT PRIMARY KEY, skillId TEXT NOT NULL, scope TEXT NOT NULL, targetId TEXT, mode TEXT NOT NULL,
  pinnedBy TEXT NOT NULL, pinnedByKind TEXT NOT NULL, byHuman INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX skill_pins_target ON skill_pins(skillId, scope, IFNULL(targetId, ''));
CREATE INDEX skill_pins_scope ON skill_pins(scope, targetId);
CREATE INDEX events_type ON events(type, id);
