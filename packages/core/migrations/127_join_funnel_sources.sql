-- Which channel brought a visitor (grant gr_ox3fmliv9n step 1, findings dc_ygehu4prlt). Additive: one counts table by UTC
-- day, source and step. `source` is a short ?ref= tag (a-z0-9-, at most 24 chars), else the external referrer's host only
-- (never a path), else "direct". `step` is homeViews or guestVisitors (a browser once per day, through join_funnel_visitors)
-- or blog:<slug> (one GET of a blog post). Counts only: no URL path, IP, user id or browser id.
CREATE TABLE join_funnel_sources (day TEXT NOT NULL, source TEXT NOT NULL, step TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, source, step));
