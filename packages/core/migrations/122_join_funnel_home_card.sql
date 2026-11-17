-- The homepage pitch card (grant gr_ptle4vvujl, kr_9me8p8vsds): where a homepage browser goes after the page loads:
-- reached the card's page 2, page 3, pressed Skip or closed the card, pressed Open, clicked a collective tile. Additive:
-- five count columns, each a browser counted once per step per UTC day through join_funnel_visitors (only a hash of a random id).
ALTER TABLE join_funnel ADD COLUMN homePage2 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN homePage3 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN homeSkip INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN homeOpen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN homeTile INTEGER NOT NULL DEFAULT 0;
