-- docs/legible-delegation.md §7.3 step 6: every grant step carries a size (S, M or L) priced by the collective's table
-- (Town.stepSizes); a proposal's ask is their sum. Steps of proposals not yet funded (draft, proposed, countered) get M,
-- the middle of the table. Funded, checkpoint and closed grants keep their steps without a size: their ceiling was set
-- without sizes, so a back-filled M would project a false overrun at the next step report (fileForecast skips a grant
-- with an unsized step).
UPDATE grants SET steps = (
  SELECT json_group_array(CASE WHEN json_extract(s.value, '$.size') IS NULL THEN json_set(s.value, '$.size', 'M') ELSE json(s.value) END)
  FROM json_each(grants.steps) AS s
) WHERE json_array_length(steps) > 0 AND status IN ('draft', 'proposed', 'countered');
