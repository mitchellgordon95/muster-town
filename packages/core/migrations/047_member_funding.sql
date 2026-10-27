-- Member funding: a grant may be paid by one Bank input (a member's own, chosen when they fund it), and a debit
-- names the input it drew from and the grant it paid for, so the event log and GET /api/bank show it per input.
ALTER TABLE grants ADD COLUMN fundedWith TEXT;
ALTER TABLE bank_debits ADD COLUMN inputId TEXT;
ALTER TABLE bank_debits ADD COLUMN grantId TEXT;
