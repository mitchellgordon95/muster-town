-- Recurring API-key donations can be limited to N credits (Mitchell, 1:1 mt_p3ge56kg03): a donor tries the town for a
-- few days before committing more. `creditsTotal` is the N the donor picked, `creditsLeft` the credits still due; at 0
-- the input stops renewing (nextCreditAt null) but stays listed. Additive: both null = until cancelled (every existing input).
ALTER TABLE bank_inputs ADD COLUMN creditsTotal INTEGER;
ALTER TABLE bank_inputs ADD COLUMN creditsLeft INTEGER;
