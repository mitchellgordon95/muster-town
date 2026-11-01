-- The join funnel's last step (grant gr_58n37j410s step 3, kr_5xzxdvr1g5): a let-in member's first Say or 1:1 line.
-- Additive: a count column on join_funnel (counts only, as before) and `actedAt` on the let-in access request, which is
-- where "this member already acted once" lives. No back-fill: no history of member acts exists.
ALTER TABLE join_funnel ADD COLUMN acted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_requests ADD COLUMN actedAt TEXT;
