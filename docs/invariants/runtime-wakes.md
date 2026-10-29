# Invariants: runtime and wakes

What must always hold in the runtime and the wakes (`packages/runtime/src/index.ts` for the tick and `scheduleWork`; `packages/runtime/src/waker.ts` for the Waker and `WAKE_RULES`; `packages/core/src/wakes.ts` for the durable wake writes; `packages/runtime/src/work.ts` for a work session). Each invariant names the test that proves it. The design is in [docs/wakes.md](../wakes.md), and the map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

Citation format: the same as in [grants.md](grants.md): a `- Test:` line with the test file, then the `it` (or `test`) text copied exactly. `npm run check:docs` fails if either is missing.

## Invariants

1. **Only the scheduler starts work, and never past `Budget.canStart`.** A wake writes a pending assignment or kicks a starter; the starter asks `canStart` (lane gate, budget, caps). An assignment that `canStart` refuses stays pending with its `heldReason` across ticks, and starts on the first tick after the gate opens. Budget exhaustion blocks the scheduler the same way.
   - Test: `packages/runtime/test/queue.test.ts` › `a tick never starts an assignment that canStart refuses: a lane-held one stays pending with its reason and starts once the gate opens`
   - Test: `packages/runtime/test/work.test.ts` › `budget exhaustion from usage sets out-of-budget and blocks the scheduler`
2. **A durable wake writes state only under a unique wakeKey**, so a replay or a double delivery writes nothing.
   - Test: `packages/runtime/test/waker.test.ts` › `live events run their rule once; the cursor passes a durable one once it has run; a restart replays nothing twice`
   - Test: `packages/core/test/wakes-relay.test.ts` › `a later tell for the same human merges into the pending one; replaying the event is a no-op`
   - Test: `packages/core/test/wakes-step5.test.ts` › `an idle requester gets one pending directed assignment with the answer; a replay writes nothing`
3. **The Waker's cursor: a first boot doesn't replay history; a durable event that arrived while the server was down is delivered once; kicks are not replayed.**
   - Test: `packages/runtime/test/waker.test.ts` › `a first boot starts at the end of the log: history is not replayed`
   - Test: `packages/runtime/test/waker.test.ts` › `a durable event that arrived while the waker was down is delivered once on boot; a kick is not replayed`
   - Test: `packages/runtime/test/waker.test.ts` › `a human's key-result edit while the server is down: the restarted runtime writes the in-tray row once and wakes the manager; the next restart writes none`
4. **One event triggers at most one wake rule** (first match wins).
   - Test: `packages/runtime/test/waker.test.ts` › `events map to the rule that handled them before; a tell has none (relayWake runs in the tell verb)`
5. **Running sessions never exceed `desks.maxRunning`**, and the queue starts the pending assignment with the lowest position.
   - Test: `packages/runtime/test/queue.test.ts` › `the scheduler never runs more sessions than the cap; held agents start on a later pass, with one notice each way`
   - Test: `packages/runtime/test/queue.test.ts` › `the scheduler starts the pending assignment with the lowest position, not the oldest`
6. **At most one session per assignment, also after a restart.** A new runtime ends orphaned running sessions and re-queues their assignments, and the new session waits until the orphan is killed.
   - Test: `packages/runtime/test/v12.test.ts` › `a new runtime ends orphaned running sessions and re-queues their active assignments`
   - Test: `packages/runtime/test/v12.test.ts` › `the re-queued assignment's new desk session waits until the orphan is killed (one session per assignment)`
7. **Every work session ends in a report**: the agent's own, or a fallback when it ends without `submit_report` or is stopped.
   - Test: `packages/runtime/test/work.test.ts` › `streams SDK messages into readable events, charges usage, ends idle with the report in the in-tray`
   - Test: `packages/runtime/test/work.test.ts` › `fallback report when the session ends without submit_report`
   - Test: `packages/runtime/test/work.test.ts` › `stopping an agent mid-session aborts it and writes a stopped fallback report`
8. **Agent-to-agent chatter can't wake anyone without a human origin.** A tell or @mention without an origin only lands in the inbox; an origin is capped at 3 hops and 24 h; and `origin` is never a verb input, so an agent can't forge one.
   - Test: `packages/core/test/wakes-relay.test.ts` › `inbox only: a busy recipient, a tell with no origin, past the hop cap, or older than 24 h`
   - Test: `packages/core/test/wakes-step5.test.ts` › `inbox only: no origin, past the hop cap, older than 24 h, or a busy target`
   - Test: `packages/core/test/origin.test.ts` › `origin is not a verb input: an agent can't put it on its tell`
9. **Nothing in the runtime touches the world after `stop()` resolves.** `runtime.stop()` stops the waker, aborts live sessions and awaits the redeployer's `stop()`: an in-flight redeploy ends at its next step, drain poll or lock wait, never exits the process, and writes no event after stop, so a caller can close the DB right after (the stale-state drain flake of main run 40454959781).
   - Test: `packages/runtime/test/redeploy.test.ts` › `stop() ends an in-flight drain without exiting and writes no event after it`
   - Test: `packages/runtime/test/redeploy.test.ts` › `runtime.stop() resolves only after an in-flight redeploy step has finished, and nothing touches the world after it`

## How it connects

- **Assignments and lanes.** The scheduler reads `nextStartable` (queue order, `waitFor`, the lane gate) and the wakes write pending assignments there. See [assignments-lanes.md](assignments-lanes.md).
- **Bank and budget.** Before a start it asks `Budget.canStart`; `fundingFor` (`packages/runtime/src/session.ts`) picks who pays; at the end `Budget.charge` books the session's adjusted output tokens.
- **Grants.** A session carries its assignment's `grantId`, and a grant's spend is the sum of those sessions; the charge's `afterCharge` runs grant checkpoints, and a grant decision's `grant.funded` event is a durable wake for the manager. See [grants.md](grants.md).
