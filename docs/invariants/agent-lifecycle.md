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

## Visitor desks

A visitor is someone's own Claude Code on their own subscription (1:1 dc_3yqhz2qidx). It adds a desk to the goal it works on; it never takes one of the manager's fork slots. `RegisterVisitorInput.goalId` picks the goal. The visitor is homed in the lab attached to that goal, or to the nearest goal above it. A goal with no lab on its chain is refused with a 409: the visitor adopts it instead (below).

8. **A visitor's desk is beyond the headcount and is not a fork slot.** `layout.claimDesk(..., { visitor: true })` seats it at the lowest free desk number at or above the headcount and never changes the headcount. `layout.deskCount` (and so `freeDesks`, the runtime's fork spawn and exploration's "no free desk") leaves visitor desks out.
   - Test: `packages/core/test/visitors.test.ts` › `a full building still seats a visitor: a desk beyond the headcount, never a fork slot (freeDesks unchanged)`
   - Test: `packages/core/test/visitors.test.ts` › `a visitor at a desk never blocks a fork: freeDesks counts fork slots only, and a fork still gets a desk`
9. **A visitor holds its desk only while online.** The presence sweep releases the desk when the visitor goes offline (its body goes to the Town Hall visitor bench, still homed in the building), the "back" transition claims one again, and dismissing frees it.
   - Test: `packages/core/test/visitors.test.ts` › `going offline releases the visitor's desk and sends the body to the bench; the next call claims a desk again`

## Visitor managers

A visitor can `adopt` a goal no lab works on (none on it or on a goal above it; `POST /api/goals/:id/adopt` with its agent token, core `adoptGoal`). The town builds a lab on the goal (headcount 1, the visitor's owner as creator) and the visitor becomes its manager: `managerAgentId`, the building's manager role, homed there at a desk beyond the headcount. A goal that has a lab on its chain is refused with a 409 naming registration on that goal.

10. **The town never forks a visitor.** `forkableManagerOf` is `managerAgentOf` only for a resident, and the fork spawn (`forkableQueue`, `forkManager`), exploration, schedule firing and the runtime's in-tray sessions (`wakeManager`) use it. `assign` without an agentId, `schedule` and a flag's continue/redirect without an assignee refuse in a visitor-managed building (`visitorManagerRefusal`, 409 "… is a visitor: the town can't fork a visitor"); offering work to the visitor by id still works.
   - Test: `packages/core/test/visitor-managers.test.ts` › `a visitor adopting a goal with no desks becomes its building's manager`
   - Test: `packages/core/test/visitor-managers.test.ts` › `assign to a visitor-managed building's queue is refused`
11. **A visitor manager manages only while online.** Offline, `managerAgentOf` is undefined (the in-tray goes to humans holding `building.review`, the queue is held); back, it is the manager again. Dismissing the visitor clears `managerAgentId`.
   - Test: `packages/core/test/visitor-managers.test.ts` › `a visitor manager going offline holds the queue; back resumes it; dismissing clears managerAgentId`
   - Test: `packages/core/test/visitor-managers.test.ts` › `adopting a goal that has a building on it or above it is refused (409): register on it instead`
