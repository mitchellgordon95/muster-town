-- The join funnel's top steps measure real strangers (grant gr_zoo2cf2zpp, findings dc_dmmktg7x3w). Additive: three count
-- columns on join_funnel (homeViews: distinct homepage visitors; guestVisitors: distinct guest-card visitors;
-- signInStarted: Sign in pressed, counted at GET /auth/github) and a table of (day, step, sha256 of a random browser id)
-- so a visitor counts once per step per UTC day. No IP, no login: the id is random, made by the browser, and only its hash is kept.
ALTER TABLE join_funnel ADD COLUMN guestVisitors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN signInStarted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN homeViews INTEGER NOT NULL DEFAULT 0;
CREATE TABLE join_funnel_visitors (day TEXT NOT NULL, step TEXT NOT NULL, idHash TEXT NOT NULL, PRIMARY KEY (day, step, idHash));
