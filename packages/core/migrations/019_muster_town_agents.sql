-- Rename P2 follow-up: 018 missed agent text and building rules (e.g. a resident's direction "What Agent Town should
-- become"). Same rule: only the case-sensitive old literal is rewritten.
UPDATE agents SET direction = replace(direction, 'Agent Town', 'Muster Town') WHERE instr(direction, 'Agent Town') > 0;
UPDATE agents SET title = replace(title, 'Agent Town', 'Muster Town') WHERE instr(title, 'Agent Town') > 0;
UPDATE buildings SET rules = replace(rules, 'Agent Town', 'Muster Town') WHERE instr(rules, 'Agent Town') > 0;
