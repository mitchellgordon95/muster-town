-- Resident memory becomes a wiki (topic pages) plus a log (docs/design.md, review 5). The one notebook an agent had
-- becomes its first wiki page, "Notes"; the agent splits it into topics as it works.
UPDATE docs SET type = 'wiki', title = 'Notes' WHERE type = 'notebook';
