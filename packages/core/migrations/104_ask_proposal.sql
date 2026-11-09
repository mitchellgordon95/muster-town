-- Legible Delegation step 9 (docs/legible-delegation.md §7.4): the Planner's calibration ask carries its table change as
-- JSON (a CalibrationProposal); deciding it "Adopt" applies it (core planner.ts). Null on every other ask.
ALTER TABLE asks ADD COLUMN proposal TEXT;
