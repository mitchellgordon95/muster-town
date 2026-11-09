-- A grant's short name (docs/legible-delegation.md §5): asks, events, the slate, deck slides and rows name a grant by its
-- title, never by quoting its objective (one long sentence that always clipped). Back-fill every existing grant from its
-- objective by the rule of schema grant-title.ts `grantTitleOf` (a test holds the two equal): parenthesised asides and
-- ellipses dropped, whitespace collapsed, the first clause up to the first comma, colon, semicolon or ". ", trailing
-- . ! ? dropped, at most 8 whole words and 60 characters, no ellipsis, the first letter upper case.
ALTER TABLE grants ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- 1. drop "(…)" asides, the first "(" to the next ")" each round; then the ellipses and stray parentheses
CREATE TEMP TABLE _gt_plain AS
WITH RECURSIVE p(id, s) AS (
  SELECT id, replace(objective, '…', '') FROM grants
  UNION ALL
  SELECT id, rtrim(substr(s, 1, instr(s, '(') - 1), ' ') || substr(s, instr(s, '(') + instr(substr(s, instr(s, '(')), ')'))
  FROM p WHERE instr(s, '(') > 0 AND instr(substr(s, instr(s, '(')), ')') > 0
)
SELECT id, replace(replace(replace(replace(replace(s, '(', ''), ')', ''), char(10), ' '), char(13), ' '), char(9), ' ') AS s
FROM p WHERE NOT (instr(s, '(') > 0 AND instr(substr(s, instr(s, '(')), ')') > 0);

-- 2. collapse runs of spaces (runs up to 32 long), then the first clause, trimmed, without trailing . ! ?
CREATE TEMP TABLE _gt_clause AS
SELECT id, rtrim(trim(substr(s, 1, min(
  CASE WHEN instr(s, ',') > 0 THEN instr(s, ',') ELSE 100000 END,
  CASE WHEN instr(s, ':') > 0 THEN instr(s, ':') ELSE 100000 END,
  CASE WHEN instr(s, ';') > 0 THEN instr(s, ';') ELSE 100000 END,
  CASE WHEN instr(s, '. ') > 0 THEN instr(s, '. ') ELSE 100000 END) - 1), ' '), '.!? ') AS s
FROM (SELECT id, replace(replace(replace(replace(replace(s, '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ') AS s FROM _gt_plain);

-- 3. at most 8 whole words and 60 characters
CREATE TEMP TABLE _gt_words AS
WITH RECURSIVE w(id, rest, out, n) AS (
  SELECT id, s || ' ', '', 0 FROM _gt_clause WHERE s != ''
  UNION ALL
  SELECT id, substr(rest, instr(rest, ' ') + 1), out || CASE WHEN n > 0 THEN ' ' ELSE '' END || substr(rest, 1, instr(rest, ' ') - 1), n + 1
  FROM w WHERE n < 8 AND length(rest) > 0 AND length(out) + (n > 0) + instr(rest, ' ') - 1 <= 60
)
SELECT id, out, n FROM w;

-- 4. the longest run per grant (none fit: the clause's first 60 characters), trailing . ! ? dropped, first letter upper
UPDATE grants SET title = coalesce((
  SELECT upper(substr(t, 1, 1)) || substr(t, 2) FROM (
    SELECT rtrim(CASE WHEN coalesce(w.out, '') = '' THEN substr(c.s, 1, 60) ELSE w.out END, '.!? ') AS t
    FROM _gt_clause c LEFT JOIN _gt_words w ON w.id = c.id AND w.n = (SELECT max(n) FROM _gt_words x WHERE x.id = c.id)
    WHERE c.id = grants.id
  )
), '');

DROP TABLE _gt_plain;
DROP TABLE _gt_clause;
DROP TABLE _gt_words;
