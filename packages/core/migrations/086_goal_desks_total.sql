-- Desks per subtree (1:1 mt_a6wb51enia, gr_yu6qw3j9x5): the most desks (sum of building headcounts) the buildings
-- attached at or under a goal may have. Totals combine as the minimum on the path to the root; null = none set here.
ALTER TABLE goals ADD COLUMN desksTotal INTEGER;
