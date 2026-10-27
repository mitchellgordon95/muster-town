# Invariants: grants

What must always hold in the grants subsystem (`packages/core/src/grants.ts`, the `Grants` service, reached as `world.grantDesk`). Each invariant names the test that proves it. The design is in [docs/goal-directed-budgets.md](../goal-directed-budgets.md), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`, see `scripts/check-doc-refs.ts`): each invariant has one or more lines like

- Test: `packages/core/test/grants.test.ts` › `refuses funding a second live grant on a key result`

The first code span is the test file. The second is the `it` text, copied exactly. If the file is missing or the text isn't in it, the check fails, so renaming a cited test means updating this doc in the same change.

## Invariants

1. **The status machine moves only along its legal edges.** draft or countered → proposed (propose); proposed → funded, countered or rejected (fund, counter, reject); checkpoint → funded (continue, adjust) or closed (cut). Any other status × action pair is refused with a conflict. (`close` withdraws or closes a grant from any status that isn't terminal. Its rules are tested separately.)
   - Test: `packages/core/test/grants.test.ts` › `every grant status × action: only the legal transitions pass`
   - Test: `packages/core/test/grants.test.ts` › `close: the manager only as stopped; funders any outcome; proposals can only be withdrawn`
2. **Only a human with `building.fund` (or a member paying from their own Bank input) decides a grant, and agents never hold `building.fund`.**
   - Test: `packages/core/test/grants.test.ts` › `only a human with building.fund decides: counter → edit → propose → fund`
   - Test: `packages/core/test/grants-schema.test.ts` › `building.fund: admins and human building managers hold it; agents never do, whatever their roles`
3. **A grant's spend is derived from the sessions that carry its `grantId` and is never stored.**
   - Test: `packages/core/test/grants.test.ts` › `spend is derived from sessions; checkpoint decisions continue / adjust / cut`
   - Test: `packages/core/test/grants-schema.test.ts` › `grants, key results, and the new building/session columns round-trip; spend derives from sessions`
4. **A grant that names no goal key result can't be proposed or funded.**
   - Test: `packages/core/test/grants.test.ts` › `a grant without a goal key result can't be proposed or funded`
5. **The 100% checkpoint fires once per `grantTokens` value and holds the grant. While it is held, only the manager's checkpoint assignment runs on it.**
   - Test: `packages/core/test/lanes.test.ts` › `a charge that reaches 100% holds the grant once and gives the manager the checkpoint assignment, which may run`
   - Test: `packages/core/test/lanes.test.ts` › `a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts`
6. **A held grant resumes only with tokens left to spend.** Continue is refused once the grant is fully spent, and adjust is refused unless the new tokens are above the spend.
   - Test: `packages/core/test/grants.test.ts` › `spend is derived from sessions; checkpoint decisions continue / adjust / cut`
   - Test: `packages/core/test/grants.test.ts` › `refuses adjust to tokens at or below the grant's spend`
7. **A key result has at most one live (funded or checkpoint) grant.** `decide` "fund" refuses a grant whose key result already has another live grant, and names that grant. Proposing is still allowed: the proposal waits in the in-tray and can be funded once the live grant closes. This matters because `liveGrantOf` (which the board, the stoplight and key-result checkpoints read) returns only the first live grant.
   - Test: `packages/core/test/grants.test.ts` › `refuses funding a second live grant on a key result`
8. **A building's manager sets a key result's status up to `claimed`. Only a human who can fund marks it met or missed, undoes that, or deletes the key result. A key result that a grant names can't be deleted.**
   - Test: `packages/core/test/grants.test.ts` › `goal key results: only humans (or the building's own manager agent) write them; manager sets status up to claimed, only funders set or undo met / missed`
   - Test: `packages/core/test/kr-authors.test.ts` › `the building's manager creates and edits its own goal's KRs; residents, other buildings and deletes stay refused`
   - Test: `packages/core/test/lanes.test.ts` › `checkpoint_grant sets the grant's goal KR status up to claimed; the checkpoint session's rollup links itself and lands in the Town Hall in-tray`

## How it connects

- **Budget → checkpoints.** After every charge, `Budget.afterCharge` calls `Grants.checkpoints` (wired in `packages/core/src/world.ts`). That moves a grant whose spend reached its tokens to `checkpoint` and queues the manager's checkpoint assignment (invariant 5).
- **Decisions → assignments.** Fund, counter and reject each queue one assignment for the building's manager agent (`decisionAssignment`). Funded queues grant-lane work with the plan; countered queues "Answer the counter"; rejected queues "read the note". If the building has no manager agent, nothing is queued.
   - Test: `packages/core/test/lanes.test.ts` › `funded: a front-of-queue grant-lane assignment with the plan, which may run`
   - Test: `packages/core/test/lanes.test.ts` › `countered: a directed 'Answer the counter' assignment with the note; rejected: 'read the note'`
- **The lane gate reads grant status.** `resolveLane` and `laneBlock` (`packages/core/src/lanes.ts`) decide whether grant-lane work may start from the grant's status: funded runs, checkpoint holds everything except the checkpoint assignment, and exploration can't name a key result that has a funded grant. Those invariants live in the assignments and lanes doc.
