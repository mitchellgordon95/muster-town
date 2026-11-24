-- The homepage pitch card was shown (grant gr_ptle4vvujl step 3): a homepage browser that the card opened for, counted when
-- the card mounts, once per browser per UTC day through join_funnel_visitors (only a hash of a random id). The card shows
-- once per browser, so homeViews also counts returning browsers that never saw it: this is the denominator for Open + tile.
ALTER TABLE join_funnel ADD COLUMN homeCard INTEGER NOT NULL DEFAULT 0;
