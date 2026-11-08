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
5. **A funded grant holds at grantTokens − min(150k, ⌊grantTokens / 3⌋); after a continue it holds again at 100%; an adjust recomputes it. Each hold fires once per `grantTokens` value, creates no assignment, and while held no new session on the grant starts (running ones finish and book). A grant already held is untouched by `checkpoints()`.**
   - Test: `packages/core/test/lanes.test.ts` › `the hold fires at grant − min(150k, a third) and creates no assignment; running work is held, the funders are told (grant C gr_95svkzi4l6)`
   - Test: `packages/core/test/lanes.test.ts` › `continue holds again at 100%; adjust recomputes the hold point; a grant already held is untouched by checkpoints()`
   - Test: `packages/core/test/lanes.test.ts` › `a funded grant already past its hold point when this lands holds at its next charge; a cut closes it`
   - Test: `packages/core/test/lanes.test.ts` › `a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts`
6. **A held grant resumes only with tokens left to spend.** Continue is refused once the grant is fully spent, and adjust is refused unless the new tokens are above the spend.
   - Test: `packages/core/test/grants.test.ts` › `spend is derived from sessions; checkpoint decisions continue / adjust / cut`
   - Test: `packages/core/test/grants.test.ts` › `refuses adjust to tokens at or below the grant's spend`
7. **Goals keep no open key results.** Every open key result belongs to an open grant: rejecting a proposal archives its key results, `close_grant` marks every open one met (archived), and the goal tree lists only archived ones (history).
   - Test: `packages/core/test/grants.test.ts` › `rejecting a proposal archives its key results; close_grant marks every open one met`
   - Test: `packages/core/test/goals.test.ts` › `the goal tree lists only archived key results; open ones live on grants`
8. **A building's manager sets the status of its grants' key results up to `claimed` (`close_grant`, or PATCH /api/key-results/:id; the checkpoint verb was removed by grant C), and so does a grant-lane fork for its own session's grant, with its report (`submit_report` `keyResults`; invariant 8a). Closing the grant as done marks its open ones met; otherwise only a human who can fund marks one met or missed, undoes that, or deletes it. A key result of an open grant can't be deleted.**
   - Test: `packages/core/test/grants.test.ts` › `a grant's key results: the manager sets status up to claimed, only funders set or undo met / missed; an open grant's can't be deleted`
   - A continue or adjust clears the top-up line (`whatTopUpBuys`, `topUpTokens`); a hold keeps the one the forks filed (test in `packages/core/test/grant-evidence.test.ts`). `GrantView.evidence` (checkpoint grants, and a proposal whose `continues` names an earlier grant of its building; null on a proposal that names none) carries per key result its verdict, note and who set it, `filed` (an agent set one), the grant's own reports (its sessions' reports, oldest first), spent vs granted, the top-up line and a close report's Shipped titles (`packages/core/test/review-deck.test.ts` › `a checkpoint slide leads with what shipped…`).
8a. **A fork files key-result evidence only for its own session's grant.** `submit_report` `keyResults` / `topUp` are accepted only when the session (else its assignment) is in the grant lane, the grant is funded or held, and every key result is an open one of that grant; status is at most `claimed` (schema). A refusal files nothing. On accept each key result gets the status, a note naming the report and `statusBy` = the fork, with a `kr.updated` event; the top-up replaces the grant's.
   - Test: `packages/core/test/grant-evidence.test.ts` › `refuses evidence from another grant's session, an exploration session, a key result of another grant, and a status above claimed`
   - Test: `packages/core/test/grant-evidence.test.ts` › `a grant-lane report sets its own grant's key results (status, a note naming the report, statusBy = the fork) and the top-up`
   - Test: `packages/core/test/grant-evidence.test.ts` › `a hold keeps the top-up the forks filed; a continue clears it`
   - Test: `packages/core/test/grant-evidence.test.ts` › `evidence() lists the grant's own reports and the forks' notes; 'No evidence filed by the forks' when none; the latest top-up wins`
   - Test: `packages/server/test/grants.test.ts` › `POST /api/verbs/submit_report: a grant-lane fork files its own grant's key-result evidence and top-up; another lane is refused (grant C, kr_13txlz2pnc)`
9. **The owner of a goal (a human) decides and funds grants, and marks key results met or missed, only within the goal's subtree;** admins and `building.fund` holders as before. Agents never fund.
   - Test: `packages/core/test/goals.test.ts` › `owners (humans) inherit down the tree, edit and fund in their subtree only; routing ends at the owner`

10. **Only a human who can fund stops a funded or checkpoint grant, and a stop winds it down before it closes.** `Grants.stop` moves it to `stopping` (not live: no new work, no claim on free tokens), interrupts every fork running on it, cancels its queued work with the reason, archives its open key results as missed with the reason and tells the manager. `finishStopping` closes it as `stopped` only once no session runs on it, recording spent, granted and unspent; a pool-funded rest is free tokens again, a member-funded rest stays on the input. A manager's close as `stopped` of a live grant is refused (403). The stop shows on the Town Hall in-tray (`stopped`, routed, never counted in the badge) and the review deck (a `stopped` slide whose call is None) while it is stopping and for 3 days after it closes.
   - Test: `packages/core/test/grant-stop.test.ts` › `only a human who can fund stops a live grant; the manager's close as stopped on it is refused, its withdraw of a proposal is not`
   - Test: `packages/core/test/grant-stop.test.ts` › `one running fork and one queued assignment: the fork is interrupted, the queued one cancelled with the reason, the grant stopping until the session ends, then closed as stopped`
   - Test: `packages/core/test/grant-stop.test.ts` › `pool-funded with nothing running: closes at once and the unspent rest is free tokens again`
   - Test: `packages/core/test/grant-stop.test.ts` › `member-funded: nothing moves, the rest stays on the member's input and the event says so`
   - Test: `packages/server/test/grants.test.ts` › `stopping a funded grant is a human's: the manager's stop and close-stopped get 403, its withdraw of a proposal 200; a funder's stop closes it and misses its key results (gr_8i952perny)`
   - Test: `packages/core/test/grant-stop.test.ts` › `a stopped grant shows on the Town Hall in-tray and the review deck for the record (who, why, spent and returned), uncounted, for 3 days after it closes`
11. **An agent decides for a human only on the human's own recent words, as that human (`act_in_1on1`, `packages/core/src/act-in-1on1.ts`, gr_kdlogzzo5s).** Only the agent of a discussing 1:1 may act, citing a line of the 1:1's own human from the last 30 min; the decision goes through `Grants.decide` / `decideRetainer` with the human's avatar as actor, so the human's gate applies unchanged. The history entry is the human's (`byId`) with `viaAgentId` / `viaMeetingId` and the note `by <Human> via <Agent> in mt_…: "<their words>"`; event `grant.decided-via`. An open outbox request (dc_…) is declined the same way through `Ops.requestAction` as the human (town.approve_request, as on the button): the request records the human as `requestDecidedById` via the agent and meeting, and the author hears why. Stop, deleting a request and Bank inputs are refused.
   - Test: `packages/core/test/act-in-1on1.test.ts` › `only the 1:1's own human's recent words count; only its agent acts; only while it is open`
   - Test: `packages/core/test/act-in-1on1.test.ts` › `the human's own gate applies: a member without building.fund is refused exactly as the button refuses them`
   - Test: `packages/core/test/act-in-1on1.test.ts` › `refuses stop and Bank inputs, and actions that don't fit the target`
   - Test: `packages/server/test/act-in-1on1.test.ts` › `does what the human said in their 1:1, as them; their gate applies; stop is refused`

## How it connects

- **Budget → checkpoints.** After every charge, `Budget.afterCharge` calls `Grants.checkpoints` (wired in `packages/core/src/world.ts`). That moves a grant whose spend reached its hold point to `checkpoint`, with no assignment (invariant 5).
- **Decisions → assignments.** Fund queues the plan's step 1 on the building queue (`queueStep`, lane grant, `grantStep` 0; no manager session); a step's report with a verdict other than pivot queues the next step (`queueNextStep`), and the manager's review stop or redirect of that report cancels it while it waits. Counter and reject each write one pending row in the building's in-tray (`decisionAssignment` → `intrayRow`, work routing step 2): "Answer the counter" (how to answer: `propose_grant` with grantId), "read the note"; no assignment. If the building has no manager agent, nothing is written.
   - Test: `packages/core/test/lanes.test.ts` › `funded: no manager assignment; the plan's step 1 is on the building queue (grant B gr_b5fyqibfx2)`
   - Test: `packages/core/test/grant-steps.test.ts` › `fund puts step 1 on the building queue (lane grant, grantStep 0, its model and pages) and no manager assignment`
   - Test: `packages/core/test/lanes.test.ts` › `countered: an 'Answer the counter' in-tray row with the note and how to answer; rejected: 'read the note' (work routing step 2)`
- **The lane gate reads grant status.** `resolveLane` and `laneBlock` (`packages/core/src/lanes.ts`) decide whether grant-lane work may start from the grant's status: funded runs, checkpoint holds every new session, and exploration names a goal gap, never a key result. Those invariants live in [assignments-lanes.md](assignments-lanes.md).
