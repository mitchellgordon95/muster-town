-- Legible Delegation step 5 (docs/legible-delegation.md §6): the Secretary's order over the open asks. 1 = first,
-- NULL = unranked; the review deck reads ranked asks first, then the rest oldest first. Additive: a nullable column.
ALTER TABLE asks ADD COLUMN rank INTEGER;
