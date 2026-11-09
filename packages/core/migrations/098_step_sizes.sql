-- docs/legible-delegation.md §7.3 step 6: every grant step carries a size (S, M or L) priced by the collective's table
-- (Town.stepSizes); a proposal's ask is their sum. Steps written before this get M, the middle of the table.
UPDATE grants SET steps = (
  SELECT json_group_array(CASE WHEN json_extract(s.value, '$.size') IS NULL THEN json_set(s.value, '$.size', 'M') ELSE json(s.value) END)
  FROM json_each(grants.steps) AS s
) WHERE json_array_length(steps) > 0;
