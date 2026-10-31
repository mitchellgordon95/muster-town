# Invariants: the Bank and budget

What must always hold where tokens come from and where they go: the Bank (`packages/core/src/bank.ts`, `world.bank`), the budget (`packages/core/src/budget.ts`, `world.budget`: `Budget.canStart`, `Budget.charge`), the finance summary (`packages/core/src/finance.ts`) and the runtime's funding and charging (`fundingFor`, `chargeUsage` in `packages/runtime/src/session.ts`). Each invariant names the test that proves it. The design is in [docs/bank.md](../bank.md), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`): each invariant has one or more lines `- Test: \`<test file>\` › \`<it text>\``, with the `it` text copied exactly. See [grants.md](grants.md) for details.

## Invariants

1. **Every figure is in adjusted output tokens, and a charge books exactly the session's `adjustedOutputTokens`.** Each token kind is weighted by its list price over the model's output price. The usage ledger, the Bank's debits and the allocation all carry the same five counters, kind by kind.
   - Test: `packages/core/test/adjusted.test.ts` › `weights each kind by its list price over the model's output price, per family`
   - Test: `packages/core/test/token-counters.test.ts` › `a bare number is already adjusted; a session's charge books exactly its adjustedOutputTokens`
   - Test: `packages/core/test/token-counters.test.ts` › `a charge by kind books its adjusted output tokens, with the same counters, into the usage ledger, the Bank's debits and the allocation`
2. **Conservation: every charge for a funded building is booked in full.** What a charge adds to the usage ledger equals what it adds to Bank debits plus allocation spend. Nothing is dropped when a source runs out: the source that takes the rest takes all of it (there is no hard stop, see 6). The one exception is usage that nothing funds by design (the Town Hall, through `recordUsage`). That usage is in the ledger and nowhere else.
   - Test: `packages/core/test/bank-invariants.test.ts` › `every charge is booked in full as Bank debits plus allocation spend, and the finance identity holds after each one`
   - Test: `packages/core/test/budget.test.ts` › `recordUsage counts unfunded usage (no allocation drawn) and still bumps the agent's counters`
3. **The finance identity holds exactly: `used + expired + left = total + overdrawn`.** `total` is credits plus donations, and `overdrawn` is usage that nothing received has paid for yet. `GET /api/finance` reports it as `sumCheck`, and the Bank page (Tokens section) shows it red when it fails.
   - Test: `packages/core/test/finance.test.ts` › `an overdrawn durable pool keeps left at 0 and books the debt as overdrawn, so the identity balances`
   - Test: `packages/core/test/finance.test.ts` › `balances on a real Bank: subscription credit, overshoot past the durable share, a donation`
   - Test: `packages/core/test/bank-invariants.test.ts` › `every charge is booked in full as Bank debits plus allocation spend, and the finance identity holds after each one`
4. **A recurring input credits once per renewal. Renewals missed while the server was down are paid once, not once per missed period**, and the next renewal moves past now. A subscription credits min(daily quota, weekly cap left).
   - Test: `packages/core/test/bank.test.ts` › `a recurring input credits only on its renewal date, once per renewal`
   - Test: `packages/core/test/bank.test.ts` › `a subscription is admin-only and credits min(daily quota, weekly cap left) each day`
   - Test: `packages/core/test/bank-invariants.test.ts` › `after downtime a renewal credits once, and a subscription's catch-up credit expires at the next renewal after now`
5. **Subscription credits expire at the next renewal and don't roll over.** A pool draws its expiring credits first (soonest to expire first), then durable ones. What wasn't drawn when a credit expires is counted as `expired`.
   - Test: `packages/core/test/bank.test.ts` › `a building draws its pool's share: expiring subscription credits first, then durable; expiring ones don't roll over`
   - Test: `packages/core/test/finance.test.ts` › `a subscription credit partly drawn is left until it expires, then its undrawn rest is expired`
6. **There is no hard stop, and every balance shown is floored at 0.** A session may overshoot: the pool's durable share goes negative, and that debt is paid back from the next credits before anything new can be spent. `balance`, `remaining`, the summary's `balanceTokens` and finance `left` never go below 0. The debt shows as `overdrawn`, and `fundingFor` returns null while the share is at or below 0.
   - Test: `packages/core/test/bank-invariants.test.ts` › `balances shown are floored at 0 after an overshoot; the debt stays in the pool's durable share and the next credit pays it back first`
   - Test: `packages/core/test/bank.test.ts` › `a building draws its pool's share: expiring subscription credits first, then durable; expiring ones don't roll over`
7. **Pool shares never pass 100%, and the Town Hall draws nothing.** Pools without an explicit share split what the explicit shares leave. An empty pool gets nothing, and buildings in a pool share it first come, first served.
   - Test: `packages/core/test/bank.test.ts` › `pools split the Bank equally unless an admin sets a share; explicit shares can't pass 100%; empty pools get nothing`
   - Test: `packages/core/test/bank.test.ts` › `a pool holding only the Town Hall gets no auto share (the Town Hall draws nothing)`
   - Test: `packages/core/test/bank.test.ts` › `buildings in one pool share it first come first served; the Town Hall in General draws nothing`
8. **Funding order is fixed: a member-funded grant's own input first, then subscription, the building's Bank share, donor-key, and api-key.** Every session runs on exactly one credential the Bank holds (a subscription input's token, an api-key input's key, a donor's key); a Bank with none holds the work, and a credential in the host env is a hard failure (post-mortem 2026-10-30).
   - Test: `packages/core/test/member-funding.test.ts` › `a session on the grant is paid from the input first, then the pool; each debit names the input`
   - Test: `packages/core/test/budget.test.ts` › `funding order: subscription → donor-key → api-key; the fallback is the first donor-key / api-key allocation`
   - Test: `packages/core/test/bank.test.ts` › `charge draws from the pool share before the building's allocations and keeps the building able to start`
   - Test: `packages/runtime/test/bank-fallback.test.ts` › `a subscription-funded building runs on the subscription input's token: one credential, no fallback key beside it`
   - Test: `packages/runtime/test/bank-fallback.test.ts` › `nothing in the Bank: held with NO_KEY_HOLD; a subscription input without its token: NO_TOKEN_HOLD (never the host env)`
   - Test: `packages/runtime/test/secrets.test.ts` › `a credential in the host env is a second auth source and a hard failure (post-mortem 2026-10-30: the env's key was billed for eight days)`
9. **One credential per session, and the Bank books the one it handed out.** The env a session starts with (host `sessionEnv`, desk `deskEnv`) carries exactly one credential variable and no failover key beside it (`assertOneCredential`); a session that dies on the subscription's cap ends there, and the *next* session is the one that runs on the Bank's API key (`Budget.failoverFunding`, while `Bank.capState().cappedAt` is set), booked to that key. The session row records the credential it was handed (`funding`, `credentialInputId`) at start; a desk claiming a different funding at the end, or an old image's in-session failover, is an `alert: funding-mismatch`, never a rebooking (1:1 mt_x40qq8poc3).
   - Test: `packages/runtime/test/secrets.test.ts` › `every session env carries exactly one credential variable: two, none, or a failover key beside one is a hard failure (1:1 mt_x40qq8poc3)`
   - Test: `packages/runtime/test/desk.test.ts` › `the desk env carries exactly one credential (the token) and no fallback key; the session row books the credential handed out`
   - Test: `packages/runtime/test/desk.test.ts` › `the Bank books what it handed out, not the desk's word: a desk claiming api-key (or an old image's in-session failover) is an alert, the session stays subscription`
   - Test: `packages/runtime/test/bank-fallback.test.ts` › `failover is the next session's pick: after a cap death the Bank hands out the api-key input's key (booked as api-key) until the cap resets; never two in one session (1:1 mt_x40qq8poc3)`
   - Test: `packages/desk/test/run.test.ts` › `a spend-limit error ends the session with the error and spendLimit; no rerun on the fallback key, which never reaches the SDK`
10. **Every day's funding is reconciled, and what the Bank can't explain is an alert.** Once per UTC day (`reconcileDue`, runtime tick), the day before is checked (`reconcileFunding`, `packages/core/src/reconcile.ts`): every api-key session ran on a Bank input, no desk claimed a funding it wasn't handed, and, when the collective secret `ANTHROPIC_ADMIN_KEY` holds the org's Admin API key, the Console's cost report for the day is explained by the Bank's api-key spend within max($1, 10%). One `system` event per day, with `alert: funding-reconcile` when it isn't; the HUD shows funding alerts for a day.
   - Test: `packages/core/test/reconcile.test.ts` › `a day whose sessions all ran on credentials the Bank lists, and whose Console spend the Bank's api-key spend explains, is OK`
   - Test: `packages/core/test/reconcile.test.ts` › `Console spend past the Bank's api-key spend and the tolerance (max $1, 10%) is an alert naming the unexplained dollars`
   - Test: `packages/core/test/reconcile.test.ts` › `an api-key session on a key the Bank doesn't list, or a desk's funding claim that didn't match, is an alert; without an Admin key the Console is not checked`
   - Test: `packages/runtime/test/reconcile.test.ts` › `sums every page's amounts (decimal cents) into USD for the UTC day, with the Admin key and version headers`
   - Test: `packages/runtime/test/reconcile.test.ts` › `a fresh town with no sessions yesterday and no Admin key stays quiet; a day with a session is reconciled once`
11. **Exhaustion stops new starts and is undone only by new tokens.** When a building's budget or an agent's daily allowance runs out, `out-of-budget` is set once with one `budget.exhausted` event. A new donation, `resetDaily` or a raised cap resumes work.
   - Test: `packages/core/test/budget.test.ts` › `daily exhaustion → out-of-budget + event; resetDaily resumes`
   - Test: `packages/core/test/budget.test.ts` › `raising the building's daily cap un-blocks a resident that hit the old one`
   - Test: `packages/core/test/budget.test.ts` › `building exhaustion stops all residents until a new donation; allocations are charged in draw order (donor key before the town key)`
12. **The cap hold applies only within one typical session of the learned subscription cap, with one `bank.hold` event per day.** If no cap has been seen, nothing is held.
    - Test: `packages/core/test/caps.test.ts` › `holds once today's spend is within one typical session of the cap; no cap = no hold`
    - Test: `packages/core/test/caps.test.ts` › `Bank.capState and GET /api/bank: no cap seen → not held; a cap at today's spend → held with a reason, one bank.hold event`

## How it connects

- **Runtime → Bank.** Before a session, `fundingFor` / `fundingForSession` (`packages/runtime/src/session.ts`) picks what pays (invariant 8). After it, `chargeUsage` calls `Budget.charge`, which books the usage (invariants 1 and 2).
- **Budget → grants.** After every charge, `Budget.afterCharge` runs `Grants.checkpoints` for the building (wired in `packages/core/src/world.ts`). A grant whose spend (summed from its sessions) has reached its tokens is held at its checkpoint. See [grants.md](grants.md), invariant 5.
   - Test: `packages/core/test/lanes.test.ts` › `a charge that reaches 100% holds the grant once and gives the manager the checkpoint assignment, which may run`
- **Budget → the lane gate.** `Budget.canStart` is the one check the scheduler uses. It checks the no-key hold, the daily allowance and the building's remaining budget, then the cap hold (invariant 10), then the lane gate (`resolveLane` / `laneBlock` in `packages/core/src/lanes.ts`). The lane gate's exploration allowance is derived from the pool's daily inflow. A held assignment keeps its `heldReason`. Those rules are in [the assignments and lanes invariants doc](assignments-lanes.md).
   - Test: `packages/core/test/lanes.test.ts` › `exploration is held once the building's exploration spend today reaches its allowance; directed is not`
