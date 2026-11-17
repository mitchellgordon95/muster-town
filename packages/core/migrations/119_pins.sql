-- One pin for every doc that enters a session (design dc_8194l8soj4 §2, grant gr_y4s2j99vgm step 1): skill_pins
-- becomes pins, its skillId becomes docId (a pin may point at any doc), and `seeded` marks a pin code placed under a
-- standing human decision (never re-created after a human removes it). Data kept; no rows rewritten.
ALTER TABLE skill_pins RENAME TO pins;
ALTER TABLE pins RENAME COLUMN skillId TO docId;
ALTER TABLE pins ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
DROP INDEX skill_pins_target;
DROP INDEX skill_pins_scope;
CREATE UNIQUE INDEX pins_target ON pins(docId, scope, IFNULL(targetId, ''));
CREATE INDEX pins_scope ON pins(scope, targetId);
