-- Rename P2: Agent Town → Muster Town in live data seeded on first boot. Only rewrites fields that still hold
-- the old literal (case-sensitive), so edits made since then are kept. Old docs/reports stay as history.
-- desks.image is left alone until the muster-town-desk image exists on the host (rename P5).
UPDATE meta SET value = json_set(value, '$.name', 'Muster Town')
  WHERE key = 'town' AND json_extract(value, '$.name') = 'Agent Town';
UPDATE meta SET value = json_set(value, '$.goal', replace(json_extract(value, '$.goal'), 'Agent Town', 'Muster Town'))
  WHERE key = 'town' AND instr(json_extract(value, '$.goal'), 'Agent Town') > 0;
UPDATE meta SET value = json_set(value, '$.tagline', replace(json_extract(value, '$.tagline'), 'Agent Town', 'Muster Town'))
  WHERE key = 'town' AND instr(json_extract(value, '$.tagline'), 'Agent Town') > 0;
UPDATE buildings SET goal = replace(goal, 'Agent Town', 'Muster Town') WHERE instr(goal, 'Agent Town') > 0;
UPDATE buildings SET description = replace(description, 'Agent Town', 'Muster Town') WHERE instr(description, 'Agent Town') > 0;
