-- Written titles for the grants made before migration 105 that are still in play on muster.town (proposed, funded,
-- at checkpoint, or named by an open ask on 2026-11-09). Migration 105 back-filled each one from its objective's first
-- clause cut at 8 words, which often stopped mid-phrase ("Let a newcomer go from first visit to"). Mitchell, 1:1 with
-- the Secretary 2026-11-09: "that was a dumb way to do it when you're an AI and you can just make proper titles".
-- Each update only touches a grant whose title is still the 105 back-fill, so a title edited since then stays; on any
-- other collective's database the ids match nothing and nothing changes. Grants whose back-filled title already reads
-- as a whole phrase are left as they are. The boot repair retitleGrantAsks (core asks.ts) then writes their asks again.
UPDATE grants SET title = 'A stranger''s Claude Code knows Muster Town' WHERE id = 'gr_uc179zv1xa' AND title = 'A stranger''s own Claude Code knows what Muster';
UPDATE grants SET title = 'Sidebars for lists, one sheet for content' WHERE id = 'gr_4csjpgh346' AND title = 'Sidebars for lists';
UPDATE grants SET title = 'Guests read reports and grants by name' WHERE id = 'gr_irjtu6tknu' AND title = 'A guest reads reports and grant pages in';
UPDATE grants SET title = 'Bring the CI check back under 3 minutes' WHERE id = 'gr_sczsxd9ztm' AND title = 'Bring the CI check back under its 3-minute';
UPDATE grants SET title = 'A PR goes green on its first push' WHERE id = 'gr_baf19xtg7p' AND title = 'A PR reaches green CI and stays mergeable';
UPDATE grants SET title = 'Bank Spending explains the non-grant half' WHERE id = 'gr_utygatbi85' AND title = 'Bank › Spending says what the non-grant half';
UPDATE grants SET title = 'Cut worst-case data loss to one hour' WHERE id = 'gr_ba0juhlm7n' AND title = 'Cut muster.town''s worst-case data loss from ~24 h';
UPDATE grants SET title = 'Self-hosted towns register in the directory' WHERE id = 'gr_8cdix9mpye' AND title = 'Strangers register a self-hosted town with muster.town''s';
UPDATE grants SET title = 'Any collective publishes its docs to GitHub' WHERE id = 'gr_30f8obzab8' AND title = 'Any collective can publish its docs to a';
UPDATE grants SET title = 'Keep onboarding material within 24 h of main' WHERE id = 'gr_mjr7nb438v' AND title = 'Bring onboarding material back under 24 h behind';
UPDATE grants SET title = 'From first visit to owning a goal' WHERE id = 'gr_bwm0iz7rwl' AND title = 'Let a newcomer go from first visit to';
UPDATE grants SET title = 'A copy of town.db holds no secrets' WHERE id = 'gr_6qlj35wnh3' AND title = 'A copy of town.db no longer hands over';
UPDATE grants SET title = 'Halve muster.town''s runtime tick' WHERE id = 'gr_db6ofyd0yf' AND title = 'Halve muster.town''s runtime tick by stopping it from';
UPDATE grants SET title = 'Recover a dead volume in 30 minutes' WHERE id = 'gr_z2v838adk9' AND title = 'Make a dead muster.town volume a 30-minute';
UPDATE grants SET title = 'Redeploys stop throwing away team-lead sessions' WHERE id = 'gr_w9ue1k1p0c' AND title = 'Stop redeploys from throwing away team-lead sessions and';
UPDATE grants SET title = 'An honest, measurable road from sign-in to member' WHERE id = 'gr_fibsfwr4tz' AND title = 'Make the stranger''s road from sign-in to member';
