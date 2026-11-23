-- Grant gr_mcuj10tupi step 1: a run can carry its own per-run cap (adjusted tokens), so the Secretary's decision,
-- backstop and "Rank now" runs are capped runs of the Town Hall's own job with no ranking schedule or retainer behind
-- them. The run watch (retainers.ts watchRunCaps) asks a run past its cap to file, as it does a retainer run past its
-- schedule's tokensPerRun. NULL = no cap of its own.
ALTER TABLE assignments ADD COLUMN runCapTokens INTEGER;
