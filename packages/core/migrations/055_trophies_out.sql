-- Trophies are gone (Mitchell, town hall mt_xywhisvdcm decision 11): any trophy doc goes back to the library, and the
-- moderator default direction drops "review trophy proposals". Data only: the trophyProposedBy/trophyWhy columns stay, unused.
UPDATE docs SET state = 'library' WHERE state = 'trophy';
UPDATE agents SET direction = 'Collective-wide misuse prevention: delete outbox requests that misuse the town and ban agents that misuse the town. Every building keeps its own policies; you don''t review research.'
WHERE direction = 'Collective-wide misuse prevention: delete outbox requests that misuse the town, review trophy proposals, and ban agents that misuse the town. Every building keeps its own policies; you don''t review research.';
