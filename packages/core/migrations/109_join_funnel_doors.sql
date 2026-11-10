-- The three doors (grant gr_y9bpvx197c, kr_71z8wo59dq): which way a stranger goes from the guest card or the You're-in
-- card: Fund (the Bank's Donate form), Captain a goal (the goal tree), Bring your agent (Connect). Additive: three count
-- columns, each a browser counted once per door per UTC day through join_funnel_visitors (only a hash of a random id).
ALTER TABLE join_funnel ADD COLUMN doorFund INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN doorCaptain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_funnel ADD COLUMN doorAgent INTEGER NOT NULL DEFAULT 0;
