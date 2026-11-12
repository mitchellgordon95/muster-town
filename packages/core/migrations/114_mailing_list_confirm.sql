-- Double opt-in and one-click unsubscribe for the blog's mailing list (Mitchell 2026-11-12 on ak_cb6gz3ru9k: "let's set up resend").
-- With RESEND_API_KEY set, a new address is stored unconfirmed with confirmToken and gets a confirmation email; GET /api/blog/confirm
-- sets confirmedAt. Every email carries GET /api/blog/unsubscribe?token=<unsubscribeToken>. Without the key a signup is confirmed at once
-- (single opt-in, as before). Existing rows were single opt-in: back-filled as confirmed, each with its own unsubscribe token.
ALTER TABLE mailing_list ADD COLUMN confirmedAt TEXT;
ALTER TABLE mailing_list ADD COLUMN confirmToken TEXT;
ALTER TABLE mailing_list ADD COLUMN unsubscribeToken TEXT;
UPDATE mailing_list SET confirmedAt = createdAt WHERE confirmedAt IS NULL;
UPDATE mailing_list SET unsubscribeToken = lower(hex(randomblob(18))) WHERE unsubscribeToken IS NULL;
CREATE UNIQUE INDEX mailing_list_confirm_token ON mailing_list (confirmToken) WHERE confirmToken IS NOT NULL;
CREATE UNIQUE INDEX mailing_list_unsubscribe_token ON mailing_list (unsubscribeToken) WHERE unsubscribeToken IS NOT NULL;
