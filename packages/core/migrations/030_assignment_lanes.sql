-- Goal-directed budgets, step 2 (waterfall step 5): every assignment runs in one spend lane. Sessions already carry
-- lane + grantId (025) and copy them from their assignment at start. `heldReason`: why the gate isn't starting it.
ALTER TABLE assignments ADD COLUMN lane TEXT NOT NULL DEFAULT 'directed';
ALTER TABLE assignments ADD COLUMN grantId TEXT;
ALTER TABLE assignments ADD COLUMN keyResultId TEXT;
ALTER TABLE assignments ADD COLUMN gap TEXT;
ALTER TABLE assignments ADD COLUMN heldReason TEXT;
