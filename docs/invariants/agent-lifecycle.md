# Invariants: agent lifecycle

What must always hold for an agent's `status`: the one state machine every agent (manager, fork, visitor, the Planner) goes through. The statuses are `AgentStatus` in `packages/schema/src/index.ts`. Next to it are the transition table `STATUS_TRANSITIONS`, `canTransition`, the predicate `isGone` (retired or banned) and its SQL twin `NOT_GONE`. `World.setStatus` (`packages/core/src/world.ts`) enforces the table. Each invariant names the test that proves it. The map is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`, see `scripts/check-doc-refs.ts`): each invariant has one or more lines like

- Test: `packages/core/test/agent-lifecycle.test.ts` › `dismiss -> stop -> resume stays retired`

The first code span is the test file. The second is the `it` text, copied exactly.

## The table

| from | may become |
|---|---|
| idle, walking, working, in-meeting, out-of-budget, offline | any of those, stopped, banned, retired |
| stopped | idle (resume), offline, banned, retired |
| banned | retired (dismissing a banned agent) |
| retired | nothing |

## Invariants

1. **Status moves only along the table.** `World.setStatus` refuses any other change with a 409 conflict ("Noor is stopped: can't become working.") and leaves the status as it was. Setting the status an agent already has is a no-op, never an error. There is no unban.
   - Test: `packages/core/test/agent-lifecycle.test.ts` › `table test: World.setStatus allows exactly the STATUS_TRANSITIONS pairs`
2. **Gone is terminal.** `isGone` is true for retired and banned and nothing else. No transition leaves retired, and banned only goes to retired. Code asks `isGone(agent)` (in SQL, `NOT_GONE`) instead of spelling out the two statuses.
   - Test: `packages/core/test/agent-lifecycle.test.ts` › `retired and banned are gone and terminal: nothing leaves retired, banned only goes to retired`
3. **Stop and resume never revive a gone agent.** `ops.stopAgent` (POST /api/agents/:id/stop) on a retired or banned agent answers 409 "X is retired." `resumeAgent` only moves `stopped` → `idle`. Before this rule, dismiss → stop → resume brought a dismissed agent back.
   - Test: `packages/core/test/agent-lifecycle.test.ts` › `dismiss -> stop -> resume stays retired`
4. **A meeting decision assigned to a gone agent doesn't revive it.** The decision still records its assignment (a retired fork's work goes to the building queue), but only a `stopped` assignee is resumed.
   - Test: `packages/core/test/agent-lifecycle.test.ts` › `meeting decision on a retired assignee does not revive it`
5. **A review decision on a gone author's report doesn't revive it.** continue, redirect and stop leave a retired author retired. Stop skips the status change, because stopped is the first step back to idle.
   - Test: `packages/core/test/agent-lifecycle.test.ts` › `review continue on a retired author does not revive it (nor stop)`
6. **The budget sweeps follow the same table.** `Budget`'s out-of-budget flip goes through `canTransition` and skips moves the table doesn't allow. So a stopped or gone agent is never made out-of-budget, and the refill sweep (out-of-budget → idle) can't bring it back.
   - Test: `packages/core/test/budget.test.ts` › `a dismissed resident stays retired through a building running dry and being refilled (2026-10-31: Root, Sage, Keel, Lena came back)`
7. **Dismissing keeps the row and drops everything live.** The desk is freed, tokens are revoked, memberships are removed and pending and active assignments are cancelled. Docs keep their author, and a retired agent is hidden from the snapshot. A fork retires the same way at the end of its session (`retireFork`, idempotent).
   - Test: `packages/core/test/v12.test.ts` › `frees the desk, revokes tokens, removes memberships, cancels assignments, keeps docs; retired hidden from the snapshot`
   - Test: `packages/core/test/forks.test.ts` › `forks the manager onto a free desk without growing the lab, names it after the manager and retires it`
