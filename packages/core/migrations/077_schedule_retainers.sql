-- Retainers (1:1 mt_cyd2t5ioob decision 2): a recurring scheduled job draws on standing money a human approved for it,
-- never on a grant (grants are one-time). A schedule carries what one run may spend (tokensPerRun, in Bank tokens: Opus
-- 5.5 output tokens) and its retainer's state; what it has drawn is derived from its runs' sessions, never stored.
ALTER TABLE schedules ADD COLUMN tokensPerRun INTEGER NOT NULL DEFAULT 0 CHECK (tokensPerRun >= 0);
-- none | asked (waits on a human in the Town Hall in-tray) | funded | countered | rejected | ended
ALTER TABLE schedules ADD COLUMN retainer TEXT NOT NULL DEFAULT 'none' CHECK (retainer IN ('none', 'asked', 'funded', 'countered', 'rejected', 'ended'));
-- funded: the approved total (drawn so far + tokensPerRun × runs left when approved)
ALTER TABLE schedules ADD COLUMN retainerTokens INTEGER;
ALTER TABLE schedules ADD COLUMN retainerDecidedBy TEXT;
ALTER TABLE schedules ADD COLUMN retainerDecidedAt TEXT;
ALTER TABLE schedules ADD COLUMN retainerNote TEXT;
-- a schedule may no longer be lane grant: live ones become retainers asking for approval (their per-run amount is set
-- by the manager's `schedule` edit, which asks again); ended ones keep their history
UPDATE schedules SET lane = 'retainer', grantId = NULL, keyResultId = NULL, retainer = 'asked' WHERE lane = 'grant' AND status = 'active';
