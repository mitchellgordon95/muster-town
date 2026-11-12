-- The blog's mailing list (Mitchell, mt_msnjkpgwdb decision 7: "an email signup for more blog posts, just a simple input
-- that adds people to a mailing list"). POST /api/blog/subscribe adds a row (insert-or-ignore); GET /api/blog/subscribers
-- (admin) lists them. No confirmation email: the town has no mail sender. Root app only (packages/server/src/mailing-list.ts).
CREATE TABLE mailing_list (
  email          TEXT PRIMARY KEY,     -- trimmed and lowercased
  createdAt      TEXT NOT NULL,
  source         TEXT NOT NULL,        -- the post slug the form was on, or 'index'
  unsubscribedAt TEXT                  -- null while subscribed (no unsubscribe route yet: an admin sets it by hand)
);
