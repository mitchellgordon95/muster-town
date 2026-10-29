-- The review deck's proposal slide (gr_jh0lu0w6yj step 4, design dc_y7a8g257of §3): propose_grant takes an optional
-- picture (an uploaded mf_… media id) and a "what you'd see" line, stored on the proposal.
ALTER TABLE grants ADD COLUMN picture TEXT;
ALTER TABLE grants ADD COLUMN whatYoudSee TEXT NOT NULL DEFAULT '';
