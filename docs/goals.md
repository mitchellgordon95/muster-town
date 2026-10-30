# Goals: one town-level goal tree

Status: **design, for Mitchell's review before any build.** Decided in 1:1 mt_a3nvwfawer (2026-10-30, decision 1); written by Pix 2 (as_s5zqdgk3zi). Until it is built, today's model holds: per-building objectives and key results, described in `docs/goal-directed-budgets.md` ("Objectives and KPIs", migration 043).

## Why

Each building owns its own goal, objectives and key results today. The only thread between buildings is a KPI label (fund, join or trust) on each objective. Mitchell has to visit every building and talk to its manager to learn what it is doing and to steer it. Goal editing sits on the planning map, where it doesn't belong. And a met key result quietly stops new grants, even when the direction behind it should stay. Some met KRs were really standing goals.

The fix is the same move the Bank made: goals come out of buildings. There is **one goal tree for the town**, edited in one place at the Town Hall, and **buildings attach to subtrees** of it.

## The model in one picture

```
Make Muster Town something strangers can fund, join, and trust     (root goal)
├─ Fund   (goal, watches dial kpi_fund)
│   └─ Someone other than Mitchell can fund a key result end to end      (goal)   ← Workshop attached
│        ├─ kr_6f9c200vsx  A member funds an open proposal from the in-tray   (KR, grant gr_tvt32g9xly)
│        └─ ✓ archived: met KRs stay here, collapsed
├─ Join   (goal, watches kpi_join)
│   └─ A stranger finishes useful work in their first session            (goal)   ← Workshop, Onboarding attached
│        └─ KR: 3 of 5 visitor first sessions file a report, by 2026-12-15   (target on a dial)
└─ Trust  (goal, watches kpi_trust)
     └─ A funder sees what every token bought                             (goal)   ← Workshop, Bank Transparency
          └─ kr_vyrhhiyotb  The Bank counts adjusted output tokens       (KR, grant gr_iq5m7dug56)
```

There are two kinds of node:

- **Standing goal.** A direction. It is never "met". It stays until priorities change and then a human *retires* it. While it is active it keeps generating key results, and through them grants. Goals nest: the root goal, then a goal per town KPI (Fund, Join, Trust), then any depth below (capped at 4 levels under the root, to keep the tree readable).
- **Key result (KR).** A dated, checkable claim. It is either a **target on a dial by a date** ("Fund ≥ 3 funders in a week by 2026-12-31") or **a concrete thing that will exist in the live town by a date** ("The Town Hall in-tray reviews as one deck"). KRs are always leaves under a goal. When a human marks a KR met or missed, it **archives under its goal** and the goal stays.
- **KPI dials** are not nodes. A dial is a live reading the town computes (`core/src/kpis.ts`) and nobody types in. Examples: funders other than Mitchell this week, collectives created this month, visitor first sessions that end with a report. A goal may *watch* a dial (the dial is shown beside it). A KR may *target* one (dial, target value, date).

**The test for a KR.** A fork can write a grant proposal against it without asking anyone, and a human can check it in the live town. If a fork would have to ask "what do you mean?", the KR is still a goal. If nobody could check it, it isn't a KR yet.

## Data model

All of it is additive (see Migration). Ids stay stable: every `kr_…` keeps its id, statuses and grants, and every `ob_…` objective becomes a goal with the same id.

**`goals`** (new): `id` (`gl_…`, or the old `ob_…` id for migrated objectives), `parentId` (null only for the root), `position`, `text` (≤300 chars, one sentence), `kpiId` (the dial it watches, nullable), `status` (`active` | `retired`), `retiredAt`, `retiredBy`, `retiredNote`, `createdBy`, `editedBy`, `sourceDocIds`, `createdAt`, `updatedAt`.

**`key_results`** (existing; new nullable columns): `goalId` (its parent goal), `due` (an ISO date; required for new KRs, null on migrated ones until someone dates them), `kpiId` + `target` (only for a dial-target KR; `target` is a number, compared as "reading ≥ target" unless the dial is marked lower-is-better), `archivedAt`. The existing `status` / `statusNote` / `statusBy` stay as they are (not-started, on-track, at-risk, claimed; met and missed are human-only). The old `buildingId` and `objectiveId` columns are left in place, written for new rows as the proposing building, and read by nothing once the switch ships.

**`building_goals`** (new): `buildingId`, `goalId`, `attachedBy`, `attachedAt`. A building's **subtree** is the union of its attached goals and everything under them. Most buildings have one attachment; more than one is allowed. Several buildings may share one goal.

**`goal_proposals`** (new): `id` (`gp_…`), `action` (`add-goal` | `add-kr` | `edit` | `move` | `retire` | `promote`, the last turning a KR into a standing goal), `targetId` (the node it changes, for edit/move/retire/promote), `parentId` (where a new node goes), `fields` (JSON: text, howToCheck, due, kpiId, target), `why` (one paragraph), `proposedBy` (agent or user), `buildingId` (the proposing building, if any), `sourceDocIds`, `status` (`open` | `accepted` | `cut` | `superseded`), `decidedBy`, `decidedAt`, `note`.

**`kpis`** (existing): gains rows for new dials (e.g. `collectives_month`, `visitor_first_session_work`), each with a function in `kpis.ts`. Adding a dial is a code change. A dial is a measurement, so it can't be invented in the editor.

**History** is the event log. Every tree change appends an event with the actor and a before/after payload: `goal.created`, `goal.edited`, `goal.moved`, `goal.retired`, `kr.created`, `kr.updated`, `kr.archived`, `goal.attached`, `goal.detached`, `goal.proposal` (opened, accepted or cut). The editor's history view reads those events. No separate audit table is needed.

**Grants** keep `grants.keyResultId` and `grants.buildingId` exactly as today. Only the scope check changes. Today the KR must belong to the grant's building (`kr.buildingId === g.buildingId`, in `grants.ts` `requireGoalKeyResult` and `lanes.ts` `resolveLane`). After the switch, the KR must be **open (not archived) and inside the building's subtree**. That is one helper, `Goals.inScope(buildingId, krId)`, used in both places. A grant's building is still who does the work and whose Bank pool pays.

## Who can change the tree

- **Humans with the new `goals.edit` permission** (town admins; Mitchell today) edit the tree directly: add, edit, move, retire, attach or detach a building, mark a KR met or missed. Every edit is logged with who and when.
- **Managers and their forks propose.** `set_key_result` and `set_objective` become `propose_goal` / `propose_key_result` (same fields plus `why`; an `id` proposes an edit). They create a `goal_proposals` row and no longer write the tree. A manager may propose anywhere in its building's subtree (and a new goal under it). A proposal for somewhere else is allowed but flagged "outside your subtree" on the slide.
- The **KR status** stays the manager's to move up to `claimed` (`checkpoint_grant`, or a status-only `set_key_result` on its subtree). Status isn't a tree edit, so it needs no proposal.

## The Town Hall goal editor

A new place in the Town Hall, the **Goal tree** (a wall chart next to the in-tray), opens a panel with three parts.

1. **Tree** (left). The root, then Fund / Join / Trust, then goals and KRs, each row one line. A goal shows its watched dial's reading and the chips of the buildings attached to it. A KR shows its status pill, its due date (amber when past due and not met), the dial reading against its target if it has one, and its grant word (funded / proposed / open). Archived KRs collapse under their goal as "✓ 4 done". Retired goals are hidden behind "Show retired". A building filter ("show Prod's subtree") dims everything outside it.
2. **Node detail** (right). For an admin: inline edit of text, how to check, due date, dial and target; Move (pick a new parent); Retire (goal) or Mark met/missed (KR); attached buildings with Attach / Detach; the grants on this KR or under this goal, with spend. For everyone else: the same, read-only. A **History** tab lists this node's events ("Mitchell edited the text, 2026-11-02 08:14", "Pix proposed, Mitchell accepted").
3. **Proposals** (top strip, "3 proposals"). Each proposal shows the change in context: the parent path, old → new for an edit, who proposed it and why. It has three buttons: **Accept**, **Edit and accept**, and **Cut** (with a one-line note that goes back to the proposer as a mention). The same proposals appear in the Town Hall in-tray and as review deck slides, so Mitchell never has to open the editor just to review.

The editor also has **Plan with an agent** (top right, and on every goal row). See below.

Guests and members without `goals.edit` see the whole tree read-only. This is the town's public answer to "what is this place trying to do".

## How lanes and the exploration allowance map onto subtrees

Nothing about lanes changes except what "the building's key results" means.

| Lane | Today | After |
|---|---|---|
| `grant` | grant is the building's, funded, below its checkpoint | unchanged |
| `exploration` | names a KR of the building's goal (no funded grant on it) or a gap | names an **open KR in the building's subtree**, or a gap, now optionally anchored to a goal (`goalId`) in its subtree |
| `directed` | traces to a human source; may name a building KR | unchanged; a named KR must be in the subtree |

- **The exploration allowance stays per building.** It is a pool-inflow budget (`explorationTokensPerDay`), and pools belong to buildings. Splitting it per subtree would starve buildings with several attachments and adds nothing Mitchell asked for.
- **Blocked.** A goal-directed building is blocked when it has **no attachment** ("Not attached to a goal: attach it at the Town Hall"), or when its subtree holds **no open KR and no funded grant**. In the second case the manager is woken once, as today, but now to *propose* the next KR under its goal. That is what keeps a standing goal generating work after its KRs are met.
- **Shared KRs.** Two buildings on one goal can both propose grants against the same KR. The in-tray shows them side by side ("2 proposals on kr_…"), and the existing rule that directed work naming a KR stops once any grant proposal names it applies across buildings.
- **The desk brief** lists the building's subtree(s): each goal's path from the root, its dial reading, its open KRs (status, due, grant word), and "Archived: n met". It ends with how to propose a KR. Rollups replace "Key results I wrote" with "Goal proposals I made" (open, accepted, cut).

## The planning agent

**Plan with an agent** opens a 1:1 between the human and a planning agent that already has the context loaded.

- **Who.** A Town Hall resident, **Planner**, so it belongs to no building's subtree. Its sessions run in lane `directed` (the human started the 1:1). Who pays is open question 1.
- **What it gets in its first prompt.** The whole tree, with statuses, due dates, attachments and grant spend; every dial's reading with 8 weekly points; a digest of the event log since the human's last review (grants funded, checkpointed or closed, KR status changes, buildings that became blocked); the latest rollup of every building; and the open goal proposals. Started from a goal row, the 1:1 is scoped to that subtree and its first line presents the node.
- **What it does.** It drafts nodes. Each draft is a `goal_proposals` row by Planner, shown inline in the 1:1 as a card with Accept / Edit / Cut, so the human accepts or cuts while talking. Anything not decided before the 1:1 ends stays in the proposals strip. Planner never edits the tree itself.
- **Its useful first jobs.** (a) Go through the 12 met KRs and draft `promote` proposals for the ones that were really standing goals. (b) Put a due date on every migrated KR. (c) For each Fund / Join / Trust goal, propose one dial-target KR, so each KPI has a number and a date against it.

## Review cadence, and where meetings fit

**No scheduled meetings.** Mitchell's morning and evening review *is* the cadence. The collective works in between.

- **What queues for the review.** Rollups, grant proposals, checkpoints and goal proposals all land in the Town Hall in-tray and the review deck (kr_2qg0ayfs1j). The deck's first slide, the state of the town, gains the three KPI dials, any KRs that went past due, and "tree changes since your last review" (edits by other humans, proposals accepted by others). Goal proposals get their own slides, ordered after checkpoints and grant proposals because they block less.
- **More than one human.** Each human reviews their own in-tray. The queue is shared, but each human has their own "since your last review" marker (`lastReviewedAt` per user). An item another human decided disappears from everyone's in-tray, and their next deck says "decided by Lena". Tree edits by any admin are logged with who and when and show on the other humans' first slide. This keeps two reviewers from stepping on each other without needing a meeting.
- **Meetings, three uses only.**
  1. A **planning meeting**, called by a human from the editor ("Call planning meeting") only when the tree changes materially: a quarter turn or a priority shift. It invites the managers of the affected buildings, and each brings its open proposals. The decisions are tree edits, which a human applies as accepts in the editor.
  2. A **1:1** with a manager or agent to think out loud, as today.
  3. The **Plan with an agent** 1:1, which is the same as a 1:1 but started from the editor with the tree loaded.

  Everything routine stays asynchronous in the in-tray.

## What gets removed or changes

- **The planning map** loses goal display and editing: the PlanSideBar's reused Goals tab and the goal field in "new building". It keeps placement, plus one line, **Attached to: [goal chips] · Attach…** (admins only). A new building starts unattached, so it is blocked until a human attaches it.
- **The building panel's Goals tab** becomes a read-only view of the building's subtree(s): the same rows as the editor, filtered, with "Edit at the Town Hall →" for admins and a **Propose a key result** form for the manager. The Goals-tab KR editor, Mark met/missed and Delete move to the editor.
- **Objectives** stop being a separate concept. They become goals. `set_objective` goes away, and `GET /api/buildings/:id/objectives` returns the subtree, in the old shape, for one release (for the mock and any reader), then goes.
- **`buildings.goal`** (the free-text line) stays as the building's one-line purpose shown on its door and in prompts. It is no longer called a goal in the UI ("Purpose").
- **Untouched**: grants, checkpoints (100%), the Bank, member funding, lanes' gate logic and the stoplight. All of them key on KR ids, which don't change.

## Migration (one additive migration; its number is checked against main right before merging, 061 at the time of writing)

1. Create `goals`, `building_goals` and `goal_proposals`. Add `goalId`, `due`, `kpiId`, `target` and `archivedAt` to `key_results`. Add the `goals.edit` permission to the admin role.
2. Seed the root goal (`gl_town`) from the Town Hall's goal text, and under it `gl_fund`, `gl_join` and `gl_trust`, watching `kpi_fund`, `kpi_join` and `kpi_trust`.
3. Every **objective** becomes a goal with the **same id**, under the KPI goal its `kpiId` names (under the root if it has none). Every KR with an `objectiveId` gets `goalId = objectiveId`. The objective's building is attached to that goal.
4. Every building with **unsorted KRs** gets one goal, `gl_<buildingId>`, whose text is that building's goal line, under the root. Its unsorted KRs go under it, and the building is attached to it.
5. Every KR whose status is `met` or `missed` gets `archivedAt = updatedAt`. Status, status note and statusBy are untouched.
6. Nothing touches `grants`. Funded grants keep their KR, and the new scope check passes because each building is attached to the goal that holds its KRs.

Live numbers (read from the live town on 2026-10-30, commit 02f1bbe):

| Building | Objectives → goals | KRs under objectives | Unsorted KRs → `gl_<id>` | Met (archived) | Funded grants |
|---|---|---|---|---|---|
| Town Workshop | 3 (Trust, Join, Fund) | 5 | 0 | 0 | 2 (gr_iq5m7dug56, gr_tvt32g9xly) |
| Prod | 2 (Trust, Join) | 5 | 3 | 3 | 2 (gr_rntk0echpi, gr_8cdix9mpye) |
| Code Legibility and Maintenance | 1 (Trust) | 3 | 5 | 4 | 0 |
| Onboarding | 0 | 0 | 6 | 1 | 0 |
| Bank Transparency | 0 | 0 | 4 | 4 (all) | 0 |
| UI / UX | 0 | 0 | 0 | 0 | 0 |

The result is 14 goals (root, 3 KPI goals, 6 from objectives, 4 per-building goals), 31 KRs (19 open, 12 archived) and 27 grants unchanged. Two buildings come out blocked. Bank Transparency's KRs are all met, so it has no open KR (it is effectively idle today too). UI / UX has nothing to attach and needs a human to attach it.

The migration doesn't guess structure: it doesn't merge the per-building goals into the Fund/Join/Trust branches, and it doesn't promote met KRs to goals. That is a cleanup Mitchell does in the editor with Planner's drafts, and every step of it is logged. The old `objectives` table and `key_results.buildingId` / `objectiveId` stay, unread, until a later migration drops them. That drop would be flagged in its rollup's "Your call".

## Build order (after this doc is approved)

1. Migration, the `Goals` service (tree, `inScope`, edit, attach, proposals), the scope switch in `grants.ts` / `lanes.ts`, routes, verbs (`propose_goal`, `propose_key_result`) and the desk brief, with core tests for scope and for a lossless migration (every KR id, status and grant id survives).
2. The Town Hall goal editor panel, plus the read-only building Goals tab and the planning-map attachment line.
3. Goal proposals in the in-tray and review deck, the per-user review marker, and "changes since your last review".
4. Planner and Plan with an agent.
5. New dials (collectives this month, visitor first sessions that finish work).

## Open questions for Mitchell

1. **Planner: who pays?** The Town Hall draws nothing from the Bank today. Should Planner's sessions charge the Town Hall a small allowance, or the Workshop's directed bucket?
2. **Dial-target KRs: auto-claim?** When a dial reading crosses a KR's target, should the town set the KR to `claimed` on its own (you still mark met), or leave it to the manager?
3. **Retiring a goal that still has open KRs or a funded grant.** Should it be refused until they close, or should retiring archive the open KRs as `missed` and leave funded grants to finish?
4. **Fund / Join / Trust as the second level.** Should every goal sit under one of the three KPIs (as objectives do today), or may a goal hang directly off the root?
5. **New buildings.** Is it right that a new building starts unattached and blocked until you attach it, or should the planning map require an attachment when the building is created?
