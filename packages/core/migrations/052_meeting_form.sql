-- One "Call a meeting" form (gr_jh0lu0w6yj step 2, Lena's design dc_tcoy1plt2r; the design said 044, taken since):
-- what each attendee brings ({mode: status|nothing|custom, text}, JSON; NULL = status) and whether the facilitator
-- opens with "Decisions needed from the humans" (until now hard-wired to kind town-hall, so existing town halls keep it).
ALTER TABLE meetings ADD COLUMN brings TEXT;
ALTER TABLE meetings ADD COLUMN askHumans INTEGER NOT NULL DEFAULT 0;
UPDATE meetings SET askHumans = 1 WHERE kind = 'town-hall';
