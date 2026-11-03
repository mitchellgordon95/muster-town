# Invariants: grants

What must always hold in the grants subsystem (`packages/core/src/grants.ts`, the `Grants` service, reached as `world.grantDesk`). Each invariant names the test that proves it. The design is in [docs/how-work-gets-done.md](../how-work-gets-done.md) §4 (older: [docs/goal-directed-budgets.md](../goal-directed-budgets.md)), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`, see `scripts/check-doc-refs.ts`): each invariant has one or more lines like

- Test: `packages/core/test/grants.test.ts` › `a grant carries its own key results under its goal; one with none can't be proposed or funded`

The first code span is the test file. The second is the `it` text, copied exactly. If the file is missing or the text isn't in it, the check fails, so renaming a cited test means updating this doc in the same change.

## Invariants

1. **The status machine moves only along its legal edges.** draft or countered → proposed (propose); proposed → funded, countered or rejected (fund, counter, reject); checkpoint → funded (continue, adjust) or closed (cut); funded or checkpoint → stopping (a human's stop) → closed (when no session runs on it). Any other status × action pair is refused with a conflict. (`close` withdraws or closes a grant from any status that isn't terminal. Its rules are tested separately.)
   - Test: `packages/core/test/grants.test.ts` › `every grant status × action: only the legal transitions pass`
   - Test: `packages/core/test/grants.test.ts` › `close: the manager only as stopped; funders any outcome; proposals can only be withdrawn`
2. **Only a human with `building.fund` (or a member paying from their own Bank input) decides a grant, and agents never hold `building.fund`.**
   - Test: `packages/core/test/grants.test.ts` › `only a human with building.fund decides: counter → edit → propose → fund`
   - Test: `packages/core/test/grants-schema.test.ts` › `building.fund: admins and human building managers hold it; agents never do, whatever their roles`
3. **A grant's spend is derived from the sessions that carry its `grantId` and is never stored.**
   - Test: `packages/core/test/grants.test.ts` › `spend is derived from sessions; checkpoint decisions continue / adjust / cut`
   - Test: `packages/core/test/grants-schema.test.ts` › `grants, key results, and the new building/session columns round-trip; spend derives from sessions`
4. **A grant is filed against a goal in its building's subtree and carries 1–5 key results of its own (`key_results.grantId`); one with none can't be proposed or funded** (docs/how-work-gets-done.md §4, migration 069). Its first key result is its `keyResultId`.
   - Test: `packages/core/test/grants.test.ts` › `a grant carries its own key results under its goal; one with none can't be proposed or funded`
   - Test: `packages/core/test/grants-schema.test.ts` › `migration 069: grants carry their key results; open goal key results with no open grant are dropped`
5. **The 100% checkpoint fires once per `grantTokens` value and holds the grant. While it is held, only the manager's checkpoint assignment runs on it.**
   - Test: `packages/core/test/lanes.test.ts` › `a charge that reaches 100% holds the grant once and gives the manager the checkpoint assignment, which may run`
   - Test: `packages/core/test/lanes.test.ts` › `a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts`
6. **A held grant resumes only with tokens left to spend.** Continue is refused once the grant is fully spent, and adjust is refused unless the new tokens are above the spend.
   - Test: `packages/core/test/grants.test.ts` › `spend is derived from sessions; checkpoint decisions continue / adjust / cut`
   - Test: `packages/core/test/grants.test.ts` › `refuses adjust to tokens at or below the grant's spend`
7. **Goals keep no open key results.** Every open key result belongs to an open grant: rejecting a proposal archives its key results, `close_grant` claims every open one for a human to mark, and the goal tree lists only archived ones (history).
   - Test: `packages/core/test/grants.test.ts` › `rejecting a proposal archives its key results; close_grant claims every open one`
   - Test: `packages/core/test/goals.test.ts` › `the goal tree lists only archived key results; open ones live on grants`
8. **A building's manager sets the status of its grants' key results up to `claimed` (`checkpoint_grant`: all open ones, or one). Only a human who can fund marks one met or missed, undoes that, or deletes it. A key result of an open grant can't be deleted.**
   - Test: `packages/core/test/grants.test.ts` › `a grant's key results: the manager sets status up to claimed, only funders set or undo met / missed; an open grant's can't be deleted`
   - At a held checkpoint `checkpoint_grant` refuses until the manager has given `whatTopUpBuys` with `topUpTokens` (both or neither); a new hold clears them. `GrantView.evidence` (checkpoint grants, and a proposal on the same goal after a grant there stopped at its checkpoint) carries per key result its verdict and note, spent vs granted, the top-up line and the checkpoint report's Shipped titles (`packages/core/test/review-deck.test.ts` › `a checkpoint slide leads with what shipped…`).
   - Test: `packages/core/test/lanes.test.ts` › `checkpoint_grant sets the status of the grant's key results up to claimed; the checkpoint session's rollup links itself and lands in the Town Hall in-tray`
9. **The owner of a goal (a human) decides and funds grants, and marks key results met or missed, only within the goal's subtree;** admins and `building.fund` holders as before. Agents never fund.
   - Test: `packages/core/test/goals.test.ts` › `owners (humans) inherit down the tree, edit and fund in their subtree only; routing ends at the owner`

10. **Only a human who can fund stops a funded or checkpoint grant, and a stop winds it down before it closes.** `Grants.stop` moves it to `stopping` (not live: no new work, no claim on free tokens), interrupts every fork running on it, cancels its queued work with the reason, archives its open key results as missed with the reason and tells the manager. `finishStopping` closes it as `stopped` only once no session runs on it, recording spent, granted and unspent; a pool-funded rest is free tokens again, a member-funded rest stays on the input. A manager's close as `stopped` of a live grant is refused (403).
   - Test: `packages/core/test/grant-stop.test.ts` › `one running fork and one queued assignment: …`, `pool-funded with nothing running: …`, `member-funded: nothing moves, …`, `only a human who can fund stops a live grant; …`
   - Test: `packages/server/test/grants.test.ts` › `stopping a funded grant is a human's: …`

## How it connects

- **Budget → checkpoints.** After every charge, `Budget.afterCharge` calls `Grants.checkpoints` (wired in `packages/core/src/world.ts`). That moves a grant whose spend reached its tokens to `checkpoint` and queues the manager's checkpoint assignment (invariant 5).
- **Decisions → assignments.** Fund, counter and reject each queue one assignment for the building's manager agent (`decisionAssignment`). Funded queues grant-lane work with the plan; countered queues "Answer the counter"; rejected queues "read the note". If the building has no manager agent, nothing is queued.
   - Test: `packages/core/test/lanes.test.ts` › `funded: a front-of-queue grant-lane assignment with the plan, which may run`
   - Test: `packages/core/test/lanes.test.ts` › `countered: a directed 'Answer the counter' assignment with the note; rejected: 'read the note'`
- **The lane gate reads grant status.** `resolveLane` and `laneBlock` (`packages/core/src/lanes.ts`) decide whether grant-lane work may start from the grant's status: funded runs, checkpoint holds everything except the checkpoint assignment, and exploration names a goal gap, never a key result. Those invariants live in [assignments-lanes.md](assignments-lanes.md).
