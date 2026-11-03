-- A grant's history-based cost estimate (Mitchell, 1:1 mt_c9u1kr15jp, 2026-11-02): recorded as JSON when it is proposed
-- (packages/core/src/grant-estimate.ts) so the close can compare estimate with actual. Null on older grants.
ALTER TABLE grants ADD COLUMN estimate TEXT;
