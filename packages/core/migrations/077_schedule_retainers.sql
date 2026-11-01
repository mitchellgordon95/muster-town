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
-- a repeating schedule may no longer be lane grant: live ones become retainers waiting on their manager (countered, so the
-- in-tray shows them without buttons): the manager's `schedule` edit sets tokensPerRun, which asks a human for approval.
-- One-shots and ended ones keep their lane.
UPDATE schedules SET lane = 'retainer', grantId = NULL, keyResultId = NULL, retainer = 'countered',
  retainerNote = 'Moved off its grant (migration 077: recurring jobs run on retainers). The manager sets tokensPerRun with a `schedule` edit, which asks for approval.'
  WHERE lane = 'grant' AND status = 'active' AND (everyMinutes IS NOT NULL OR dailyAt IS NOT NULL);
