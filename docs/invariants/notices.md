# Invariants: notices, the Secretary's ranking and the policy ledger

What must always hold for notices (`packages/core/src/notices.ts`, the `notices` table from migration 102), the Secretary's ranking run (`packages/core/src/secretary.ts`, `asks.rank` from migration 101) and the policy ledger. A notice is a state change with nothing to do; the Secretary orders the asks and never decides one. Each invariant names the test that proves it. The design is in [docs/legible-delegation.md](../legible-delegation.md) §6 and §8 (build step 5 in §11), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`, see `scripts/check-doc-refs.ts`): each invariant has one or more lines like

- Test: `packages/core/test/notices.test.ts` › `a funded grant closed as done files its closed loop (funded on, for, closed at, what it bought), rewritten once its close report lands`

The first code span is the test file. The second is the `it` text, copied exactly.

## Invariants

1. **Each writer files its notice where the change happens.** A rollup's submit files one `shipped` notice per Shipped item (its "What you'd see" line and first picture), once per rollup; a funded grant closed as done files one `closed-loop` notice (funded on, for, closed at, what its close report says it bought), rewritten in place once the close report is linked; a key result a human marks met files a `verified` notice (a close as done, which marks every open one met, does not). `listNotices` (`GET /api/notices`) is newest first and filters by building, goal, kind and limit.
   - Test: `packages/core/test/notices.test.ts` › `a rollup's submit files one shipped notice per Shipped item (its What you'd see line and picture); one that asks nothing is archived`
   - Test: `packages/core/test/notices.test.ts` › `a funded grant closed as done files its closed loop (funded on, for, closed at, what it bought), rewritten once its close report lands`
   - Test: `packages/core/test/notices.test.ts` › `a key result a human marks met files a verified notice; the Secretary's pattern note is a notice (its slate: secretary-rank.test.ts); the list filters by building, goal, kind and limit, newest first`
2. **A rollup that asks nothing of its own is archived on submit.** No live ask has it as its record (every ask folded into one already open, or none): it is archived by the system (or acknowledged as folded); one that still asks something stays pending; a grant's close or checkpoint report stays.
   - Test: `packages/core/test/notices.test.ts` › `a rollup's submit files one shipped notice per Shipped item (its What you'd see line and picture); one that asks nothing is archived`
3. **The ranking run orders, defers and recommends; it never decides money.** `rank` with `order` sets each live ask's rank and clears the rank of one left out; `defer` parks an open ask behind the ask it is moot without (`deferAsk`, stamped by the Secretary); `slate` files one `slate` notice citing only open money asks. No grant changes and no ask is decided; only the Secretary may call it. The review deck reads the asks in rank order and opens on today's slate.
   - Test: `packages/core/test/secretary-rank.test.ts` › `rank reads the open asks; with order and slate it sets the ranks and files the slate as a notice citing ask ids`
   - Test: `packages/core/test/secretary-rank.test.ts` › `defers an ask behind the one it is moot without; refuses a non-money ask on the slate and anyone but the Secretary`
   - Test: `packages/core/test/secretary-rank.test.ts` › `never decides money: no grant changes, no ask is decided, the run prompt says so`
4. **The Secretary and its runs are on Fable, and a due run with nothing new is skipped before any session.**
   - Test: `packages/core/test/secretary.test.ts` › `takerId: a Town Hall schedule needs a resident taker; the ranking schedule asks its retainer, runs on Fable, and fires to the Secretary's own queue`
   - Test: `packages/core/test/secretary.test.ts` › `skips the run (no session) when there is no open ask, or nothing arrived since the last ranking`
5. **Only a human adds a rule to the policy ledger, and only a standing rule is proposed.** Deciding a policy ask (Keep or any branch) and a decision `act_in_1on1` did for a human file no "Add this rule to the ledger?" ask (Mitchell's 1:1 mt_msnjkpgwdb, decisions 6 and 8). The Secretary's pattern note may propose one, with the proposed line as its body; only a human's "Add" appends the line; deciding it never files another. The ledger's rules are in every manager's first message.
   - Test: `packages/core/test/policy-ledger.test.ts` › `deciding a policy ask files no ledger ask; a proposed rule's Add appends the line, Skip doesn't; the ledger block is in the pinned text`
   - Test: `packages/core/test/policy-ledger.test.ts` › `act_in_1on1 doing a decision the human said files no ledger ask`
