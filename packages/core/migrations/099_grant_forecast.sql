-- docs/legible-delegation.md §7.3 step 7: the forecast filed at a grant's latest step report (GrantForecast as JSON;
-- NULL until a step reports), and whether it projected past the ceiling (a later step turns that into a money ask).
ALTER TABLE grants ADD COLUMN forecast TEXT;
ALTER TABLE grants ADD COLUMN needsTopUp INTEGER DEFAULT 0;
