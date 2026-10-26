-- Bank grant step 2 (gr_iq5m7dug56): a session keeps its five token counters per model (JSON {model: counts}), so its
-- adjusted output tokens (derived in core/src/bank.ts, never stored) can price each model's tokens at that model's list
-- price: a Fable session's Haiku subagent input is not Fable input. NULL = no per-model usage reported (older sessions).
ALTER TABLE sessions ADD COLUMN byModel TEXT;
