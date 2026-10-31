# Invariants: assignments and lanes

What must always hold for assignments and their lanes (`packages/core/src/domain.ts` for `createAssignment`, `nextStartable` and the queue; `packages/core/src/lanes.ts` for `resolveLane` and the lane gate `laneBlock`; `packages/core/src/waits.ts` for `waitFor`). Each invariant names the test that proves it. The design is in [docs/goal-directed-budgets.md](../goal-directed-budgets.md), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

Citation format: the same as in [grants.md](grants.md): a `- Test:` line with the test file, then the `it` (or `test`) text copied exactly. `npm run check:docs` fails if either is missing.

## Invariants

1. **In a lab, agent-made work has a lane, and directed work cites a human source.** An agent must say `grant` (a grant of the building) or `exploration` (a gap); it creates `directed` work only with a `sourceId` that a human wrote or took part in. Humans may still create directed work. A continuation inherits its lane. Only the Town Hall keeps "no lane = directed".
   - Test: `packages/core/test/lanes.test.ts` › `goal-directed: agents must say grant or exploration; fields are validated; humans may still create directed work`
   - Test: `packages/core/test/lanes.test.ts` › `an agent creates directed work only when it cites a human source; it is stored and never held by the allowance`
   - Test: `packages/core/test/lanes.test.ts` › `every lab is lane-gated, even one created without budgetMode or with a stale open row; the Town Hall never is`
2. **Grant-lane work can't name a closed, rejected or draft grant.** `resolveLane` refuses them, because no work may be charged to them. A proposed or countered grant is accepted, but the lane gate holds the work until the grant is funded.
   - Test: `packages/core/test/lanes.test.ts` › `a grant assignment can't name a closed, rejected or draft grant; proposed, funded and checkpoint ones are accepted (and the gate holds the unfunded)`
3. **Exploration and directed work name no key result** (key results belong to grants, docs/how-work-gets-done.md §4): exploration names a gap, directed work may. Grant-lane work stores its grant's first key result.
   - Test: `packages/core/test/lanes.test.ts` › `exploration names a gap and directed work may; neither names a key result`
4. **A session copies its lane and `grantId` from its assignment when it starts**, so a grant's spend (summed from sessions) counts exactly the work done in its lane.
   - Test: `packages/core/test/lanes.test.ts` › `a session copies lane and grantId from its assignment at start`
5. **The lane gate holds, it never cancels.** A held assignment stays `pending` with a `heldReason`, and work queued behind it still starts. Exploration is held only when no tokens are free under the building's goal or the goal's optional exploration cap is reached today (no allowance: docs/how-work-gets-done.md §8); directed work never is; the Town Hall never holds on lanes.
   - Test: `packages/core/test/lanes.test.ts` › `a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts`
   - Test: `packages/core/test/lanes.test.ts` › `exploration is held with no free tokens, or once its goal's optional cap is reached today; uncapped by default; directed is never held`
   - Test: `packages/core/test/lanes.test.ts` › `the Town Hall never holds on lanes; a lab does`
   - Test: `packages/core/test/blockers.test.ts` › `lane holds point at the Town Hall in-tray: grant at checkpoint, exploration at its goal's cap (used of cap, reset time)`
6. **Directed work is never held for money** (the rule that stopped directed work once a grant proposal named its key result went with goal key results, migration 068).
   - Test: `packages/core/test/lanes.test.ts` › `exploration is held with no free tokens, or once its goal's optional cap is reached today; uncapped by default; directed is never held`
7. **`waitFor` holds the start.** The scheduler skips a waiting assignment until its wait is met. A wait still unmet after 24 h is cancelled into the in-tray, and a chain parks at most 3 times in a row.
   - Test: `packages/core/test/waits.test.ts` › `the scheduler skips a waiting assignment until checkWaits finds it met; then it unblocks with an event`
   - Test: `packages/core/test/waits.test.ts` › `a wait unmet after 24 h is cancelled into the in-tray; Continue there queues it again without the wait`
   - Test: `packages/core/test/waits.test.ts` › `a chain parks at most 3 times in a row`
   - A wait on a time (`{after}`, only parked work now: `submit_report resumeWhen`) is not a block: `blockedBy` returns null for it (`waitsOnTime`). Timed jobs are building schedules (below). Test: `packages/core/test/blockers.test.ts` › `a wait on a time (work parked with resumeWhen {after}) is not a block, before or after the time`
   - `buildingStats` (GET /api/buildings/:id/stats, town planning's side bar) counts a building's active assignments as running and its pending ones as queued (blocked ones counted again under `blocked`), and `scheduled` = its active schedules; offers are left out. Test: `packages/core/test/blockers.test.ts` › `buildingStats (town planning's side bar): running, queued (blocked among them), the building's active schedules; agents, forks, working; the live build`
   - **A timed job lives on its building, never on an agent** (Mitchell, 1:1 mt_w7z9k1z112; docs/scheduling.md). `assign waitFor {after}` is refused (use `schedule`); nothing exists for any agent before a schedule fires. When it fires, `fireSchedules` creates one assignment for whoever is around: the building queue with forks on, else the idle resident with the shortest queue, else the manager. A one-shot ends after it runs; a repeat moves to its next occurrence (missed runs collapse into one), skips while its last assignment is still queued, and ends past `endsAt` (default 14 days, at most 90). A lane that no longer holds ends it with a `schedule-ended` report in the in-tray. Test: `packages/core/test/schedules.test.ts`
8. **One owner, one queue order.** An assignment belongs to one agent; the next one started is the pending one with the lowest position. Nothing moves queued work between agents: a building has one named manager, and an agent's `assign` names only itself or a visitor; everything else goes on the building queue for a fork (1:1 mt_wngibcr98b decision 1). Cancel works on pending assignments only.
   - Test: `packages/core/test/assignment-queue.test.ts` › `new assignments get epoch-ms positions; the next pending orders by position, then createdAt, rowid`
   - Test: `packages/core/test/manager-verbs.test.ts` › `assign: no agentId = the building queue; agentId = the manager itself or a visitor, never another named agent`
   - Test: `packages/core/test/assignment-queue.test.ts` › `cancelAssignment: pending only; active, done and cancelled refuse`

## How it connects

- **Grants → the gate.** `resolveLane` and `laneBlock` read the grant's status (funded runs; checkpoint holds all but the manager's checkpoint assignment; anything else holds or is refused) and the exploration allowance from `Grants.exploration`. Grant decisions write assignments back into this subsystem. See [grants.md](grants.md).
- **Bank and budget → the gate.** `laneBlock` is the lane half of `Budget.canStart`; the other half is the building's remaining tokens and daily caps (`packages/core/src/budget.ts`). `nextStartable` returns only an assignment that `canStart` allows.
- **Runtime and wakes.** The runtime starts only what `nextStartable` returns, and the wakes create pending assignments here (a human's tell, a relayed @mention, a decision). See [runtime-wakes.md](runtime-wakes.md).
