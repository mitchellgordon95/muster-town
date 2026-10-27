-- Outbox requests need no moderator approval: every pending (proposed) or approved request is open to humans.
UPDATE docs SET requestStatus = 'open' WHERE type = 'request' AND requestStatus IN ('proposed', 'approved');
