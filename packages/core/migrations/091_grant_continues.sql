-- A proposal names the earlier grant it continues (propose_grant `continues`, 1:1 mt_z1b38bwg98): its card shows that
-- grant's checkpoint evidence, and no other grant's (before, the latest checkpointed grant on the same goal was picked).
ALTER TABLE grants ADD COLUMN continues TEXT;
