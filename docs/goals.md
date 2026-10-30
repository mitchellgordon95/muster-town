# Goals: one town-level goal tree

Status: **design, for Mitchell's review before any build.** Decided in 1:1 mt_a3nvwfawer (2026-10-30, decision 1). First pass by Pix 2 (as_s5zqdgk3zi). The second pass, by Pix 1 (as_bb0wrwf0v7), adds owners, "Change this goal", budget by node, KPI slides, skip-levels, postmortems and the kanban view. Until this is built, today's model holds: per-building objectives and key results, described in `docs/goal-directed-budgets.md` ("Objectives and KPIs", migration 043).

## Why

Today each building owns its own goal, objectives and key results. The only thread between buildings is a KPI label (fund, join or trust) on each objective. To learn what a building is doing, or to steer it, Mitchell has to visit it and talk to its manager. Goal editing sits on the planning map, where it doesn't belong. And a met key result quietly stops new grants, even when the direction behind it should stay: some met KRs were really standing goals.

The fix is the move the Bank already made: goals come out of buildings. There is **one goal tree for the town**, edited at the Town Hall, and **buildings attach to subtrees** of it.

A note on scope. Mitchell observed that this is turning into an org/corporation sim. It borrows only what the town needs: an owner per node, one reorg action, and a board view of the queue. It takes no lean, agile or waterfall ceremony. There are no sprints, standups, retros or scheduled planning. **The iteration is Mitchell's morning and evening review, plus small assignments in between.** The one scheduled meeting the tree needs is the reorg meeting (§ "Change this goal").

## The model in one picture

```
Make Muster Town something strangers can fund, join, and trust     (root goal, owner: Mitchell)
├─ Fund   (goal, watches dial kpi_fund)
│   └─ Someone other than Mitchell can fund a key result end to end      (goal)   ← Workshop attached
│        ├─ kr_6f9c200vsx  A member funds an open proposal from the in-tray   (KR, grant gr_tvt32g9xly)
│        └─ ✓ archived: met and missed KRs stay here, collapsed
├─ Join   (goal, watches kpi_join)
│   └─ A stranger finishes useful work in their first session            (goal)   ← Workshop, Onboarding attached
│        └─ KR: 3 of 5 visitor first sessions file a report, by 2026-12-15   (target on a dial)
└─ Trust  (goal, watches kpi_trust)
     └─ A funder sees what every token bought                             (goal)   ← Workshop, Bank Transparency
          └─ kr_vyrhhiyotb  The Bank counts adjusted output tokens       (KR, grant gr_iq5m7dug56)
```

- **Standing goal.** A direction. It is never "met". A human *retires* it when priorities change, or *changes* it (a reorg). While it is active, it keeps generating key results and, through them, grants. Goals nest: the root, then one goal per town KPI (Fund, Join, Trust), then at most 4 more levels.
- **Key result (KR).** A dated, checkable claim. It is either **a target on a dial by a date** ("Fund ≥ 3 funders in a week by 2026-12-31") or **a concrete thing in the live town by a date** ("The Town Hall in-tray reviews as one deck"). A KR is always a leaf under a goal. When a human marks it met or missed, it **archives under its goal**, and the goal stays.
- **KPI dials** are not nodes. A dial is a live reading the town computes (`core/src/kpis.ts`, with 8 weekly points). Nobody types it in. A goal may *watch* a dial, and a KR may *target* one (dial, target value, date).

**The test for a KR.** A fork could write a grant proposal against it without asking anyone, and a human could check it in the live town. If a fork would have to ask "what do you mean?", the KR is still a goal.

## Data model

Everything is additive (see Migration). Ids stay stable: every `kr_…` keeps its id, statuses and grants, and every `ob_…` objective becomes a goal with the same id.

- **`goals`** (new): `id` (`gl_…`, or the old `ob_…`), `parentId` (null only for the root), `position`, `text` (≤300 chars), `kpiId` (the dial it watches, nullable), `ownerId` (nullable; see Owners), `status` (`active` | `retired`), `retiredAt/By/Note`, `createdBy`, `editedBy`, `sourceDocIds`, `createdAt`, `updatedAt`.
- **`key_results`** (existing) gains nullable columns: `goalId`, `due` (an ISO date; required for new KRs), `kpiId` + `target` (dial-target KRs only; "reading ≥ target" unless the dial is lower-is-better), `archivedAt`, `underReviewSince` (set by a reorg), `postmortemDocId`. `status`, `statusNote` and `statusBy` stay as they are. The old `buildingId` and `objectiveId` stay in place: they are written as the proposing building and read by nothing.
- **`building_goals`** (new): `buildingId`, `goalId`, `attachedBy`, `attachedAt`. A building's **subtree** is the union of its attached goals and everything under them. Usually a building has one attachment; several buildings may share a goal.
- **`goal_proposals`** (new): `id` (`gp_…`), `action` (`add-goal` | `add-kr` | `edit` | `move` | `retire` | `promote`; promote turns a KR into a goal), `targetId`, `parentId`, `fields` (JSON), `why`, `proposedBy`, `buildingId`, `reorgId` (nullable), `sourceDocIds`, `status` (`open` | `accepted` | `cut` | `superseded`), `decidedBy/At`, `note`.
- **`goal_changes`** (new, the reorg): see "Change this goal".
- **`kpis`** gains new dials (e.g. `collectives_month`, `visitor_first_session_work`). Each new dial needs a function in `kpis.ts`, so adding one is a code change, not an edit.
- **History is the event log.** Every change appends an event with the actor and a before/after payload: `goal.created / edited / moved / retired / owned / changed`, `kr.created / updated / archived / under-review`, `goal.attached / detached`, `goal.proposal`. The editor's History tab reads these events. There is no audit table.

**Grants** keep `keyResultId` and `buildingId`. Only the scope check changes. Today the KR must belong to the grant's building (`grants.ts` `requireGoalKeyResult`, `lanes.ts` `resolveLane`). After the switch, the KR must be **open (not archived) and in the building's subtree**: one helper, `Goals.inScope(buildingId, krId)`. The grant's building still does the work, and its Bank pool still pays.

## Who can change the tree

- **Humans with `goals.edit`** (town admins; Mitchell today) edit the tree anywhere: add, edit, move, retire, change (reorg), attach or detach, set owners, and mark KRs met or missed. A node's **owner** can do all of that inside the subtree they own (see Owners).
- **Managers and their forks propose.** `set_objective` and `set_key_result` become `propose_goal` / `propose_key_result`. They take the same fields plus `why`, and an `id` proposes an edit. Each creates a `goal_proposals` row. A proposal outside the building's subtree is allowed but flagged.
- **KR status** up to `claimed` stays the manager's (`checkpoint_grant`, or a status-only `propose_key_result` on its subtree). A status change is not a tree edit.

## The Town Hall goal editor

There is a new place in the Town Hall, the **Goal tree** (a wall chart by the in-tray). It opens a panel with three parts:

1. **Tree** (left). One line per row. A goal row shows its owner's avatar, its dial reading and its attached-building chips. A KR row shows its status pill, its due date (amber when past due), its dial reading against its target, and a grant word (funded / proposed / open). Archived KRs collapse under their goal ("✓ 4 done, 1 missed"). Retired goals hide behind "Show retired". A building filter dims everything outside one building's subtree.
2. **Node detail** (right). Admins and the node's owner get inline edit, Move, Retire or Mark met/missed, Attach/Detach, Owner, and **Change this goal**. Everyone else gets the same panel read-only. Its tabs:
   - **History**: the node's events.
   - **Subtree**: the owner's view, see Owners.
   - **Spend**: see Budget by node.
   - **Queue**: the kanban view.
   - **Talk to a resident under this goal**: the skip-level 1:1.
3. **Proposals** (top strip). Each proposal shows the change in context: the parent path, old → new, who proposed it and why. Buttons: **Accept**, **Edit and accept**, **Cut** (its note goes back to the proposer as a mention). The same proposals show in the in-tray and the review deck.

**Plan with an agent** (top right, and on every goal row) opens a 1:1 with Planner (below). Guests and members see the whole tree read-only. It is the town's public answer to "what is this place trying to do".

## Owners on nodes

**What.** Any goal may have an `ownerId`: a human user now. The field is an agent-or-user id, so an agent can own a node later without a migration. Ownership inherits: a node with no owner belongs to its nearest owned ancestor. The root is owned by the town admins (Mitchell) and can't be unowned. **The org chart is derived, not declared:** an owner's reports are the managers of the buildings attached in their subtree, and their own manager is the owner of the nearest owned ancestor. The UI draws it as the tree, filtered to owned nodes.

**Routing.** Every Town Hall item routes to the owner of the node it belongs to:

- a **grant proposal or checkpoint** belongs to its KR's goal;
- a **goal proposal** belongs to its target or parent node;
- a **rollup** belongs to the building's attachment.

For a building with several attachments, the rollup goes to the nearest common owned ancestor of its attachments. The Town Hall in-tray stays one queue: each human sees **"Mine"** (items routed to them, the default) and **"All"**. The first human to decide an item clears it for everyone, as the per-user review marker already does. With one human, every route ends at Mitchell and nothing changes. With several, the in-trays split by subtree, which answers the multi-human review question without a meeting.

**Permissions.** An owner holds `goals.edit` scoped to their subtree: they can edit, accept proposals, mark met/missed, attach, and set owners below them. Funding stays `building.fund`, a separate grant of power (open question 6).

**UI.** The node page's **Subtree** tab is the owner's rollup of rollups:

- every attached building's last rollup line and stoplight;
- open KRs by due date;
- grants with spend against their ceilings;
- the dials watched in the subtree;
- what is waiting on the owner.

The building panel's Overview gains "Reports to: <owner> via <goal>".

**Lanes, grants, Bank.** No change. Ownership routes review and scopes `goals.edit`, nothing else.

## "Change this goal" (the reorg)

**What.** On a goal, an admin or the node's owner writes **X → Y** (the new text, a paragraph of why, and a meeting date at least 24 h ahead). That creates:

- **A `goal_changes` row**: `id` (`gc_…`), `goalId`, `fromText`, `toText`, `why`, `meetingAt`, `meetingId`, `sourceDocId`, `status` (`scheduled` | `meeting` | `decided`), `createdBy`, `decidedAt`.
- **A note doc** authored by the human ("Change this goal: X → Y", filed at the Town Hall). This is the human source for all the directed work below, so `lanes.ts` `humanSource` needs no change.
- **A planning meeting** (`kind: planning`, at the Town Hall) scheduled for `meetingAt`. Its invitees are the owner(s) in the subtree and the manager of every building attached under the node. Planner facilitates, because the Town Hall has no manager.
- **One directed assignment per building** under the node, on its building queue, with source = the note: "Review your work against Y. Bring proposals for what goes underneath (`propose_goal` / `propose_key_result` with `reorgId`), and say which of your KRs and grants still serve Y."
- **"Under review" on every open KR under the node** (`underReviewSince`). The KR keeps its status, and its **grants keep running until a human cuts them**. The tree, desk briefs and in-tray show a "under review" pill. A new grant proposal on an under-review KR is allowed but flagged.

**At the meeting.** The goal text becomes Y when the meeting starts. Each manager presents its proposals, and the human accepts or cuts them on the spot (Planner records each acceptance as a meeting decision). **The accepted proposals become the node's new children.** For each under-review KR, the human decides: **Keep** (clears the flag), **Move** (to another goal), or **Archive** (as missed, or retired with Q3's rule). Grants on archived KRs go to the in-tray as Cut candidates. When the meeting ends, the change becomes `decided`. KRs left undecided stay under review and get a deck slide each until they are decided.

**Why a meeting here, and nowhere else.** A reorg changes many buildings' work at once. Proposals from several managers have to be weighed against each other, and the in-tray handles one item at a time. Every other tree change is a single proposal.

**Lanes, grants, Bank.** The assignments are directed (human source = the note). Grants are untouched until a human cuts them. With budget by node (below), the node's budget moves with the node.

## Budget by node (proposed option; needs Mitchell's approval as a Bank change)

**Today.** The Bank allocates by building. Inputs credit the Bank, **pools** (`BankPool`, `pct` of the Bank) group buildings, and a building's sessions debit its pool first come, first served. Grants are ceilings on that, not reservations. Member-funded grants pay from their own input (`docs/goal-directed-budgets.md`, `docs/bank.md`). So when a reorg moves a goal from one building to another, the money stays with the old building.

**Option, in two halves:**

1. **Spend by node, read-only. No Bank change.** Every `BankDebit` already carries `buildingId`, `agentId` and `grantId`. It is attributed to a node by its session's lane:
   - `grant` → the grant's KR's goal;
   - `exploration` or `directed` naming a KR or goal → that node;
   - anything else → the building's attachment (split evenly when the building has several).

   The node's **Spend** tab shows, for its subtree, adjusted output tokens by week and by lane next to the results: KRs met or missed and the change in watched dials over the same weeks. That is "spend vs result" with no new money rules. It could ship with step 3 of the build order if Mitchell wants it early. It is still listed here because it defines the attribution that the second half uses.
2. **Allocate by node. A Bank change, gated on Mitchell.** A goal may carry a `pct` (a share of the Bank, as pools do). An attached building draws from the nearest budgeted node above its attachment, instead of from its pool. A building with no budgeted ancestor falls back to its pool. Grants under the node draw against the node's share. Because the money sits on the node, **a reorg or a re-attachment moves the money with the work**. Pools would then be a degenerate case: one budgeted node per pool, which the migration could create.

**Lanes, grants.** The exploration allowance stays per building (below). Grant ceilings are unchanged. Only which balance a grant debits would change.

## How lanes and the exploration allowance map onto subtrees

| Lane | Today | After |
|---|---|---|
| `grant` | grant is the building's, funded, below its checkpoint | unchanged |
| `exploration` | names a KR of the building's goal (no funded grant) or a gap | names an **open KR in the building's subtree**, or a gap optionally anchored to a goal in its subtree |
| `directed` | traces to a human source; may name a building KR | unchanged; a named KR must be in the subtree |

- **The exploration allowance stays per building.** Pools belong to buildings, and splitting the allowance per subtree would starve buildings with several attachments.
- **Blocked.** A goal-directed building is blocked when it has **no attachment**, or when its subtree has **no open KR and no funded grant**. In the second case, the manager is woken once to *propose* the next KR. That is how a standing goal keeps generating work.
- **Shared KRs.** Two buildings on one goal can both propose against one KR. The in-tray shows the proposals side by side, and "directed work naming a KR stops once a grant proposal names it" applies across buildings.
- **The desk brief** lists the building's subtree(s): each goal's path from the root, its owner and dial, its open KRs (status, due date, grant word, under review), and "Archived: n met, m missed". Rollups replace "Key results I wrote" with "Goal proposals I made".

## Postmortems on missed KRs

**What.** When a human marks a KR **missed**, the dialog asks for a line on why. That line is filed as a note by the human, and the note is the human source. Marking it missed then queues **one directed assignment** on the building queue of the building whose grant named the KR (or, failing that, the building that proposed the KR): "Postmortem on kr_…: what we planned, what happened, what we'd do differently, and whether the goal needs a new KR. One screen. No new work." The assignment is capped small (stop condition: one report). Its report is filed with `postmortemOf = kr_…`, and the KR's `postmortemDocId` points to it. Two postmortems are never queued for one KR. A KR archived by a reorg as missed gets one too.

**UI.** In the editor, the archived "✗ missed" row opens its postmortem. The report also reaches the manager's in-tray, as any report does. If it ends with a KR proposal, that proposal lands in the Proposals strip.

**Lanes, grants, Bank.** The work is directed (a human marked it missed). Its spend shows in the node's Spend tab under the KR's goal. Nothing is queued for met KRs.

## Skip-level: talk to a resident under this goal

**What.** **Talk to a resident under this goal** on a goal's detail picks, at random, a building attached in the subtree, then a resident of it who did work there in the last 7 days, and opens a 1:1 through the existing route (`createOneOnOne` with `agentId`). The manager is not invited and is not told. The meeting notes are filed in that building's cabinet, as any 1:1's are. The human can re-roll the pick.

**The catch.** Most residents are now manager forks, and a fork can't hold a 1:1: `oneOnOneTarget` sends a fork's 1:1 to its manager, which defeats the point. So the skip-level picks:

- **a named resident**, when the subtree has one;
- **otherwise a recent fork chain** (a report from the last 7 days). The 1:1 then runs a **conversational fork session**: a fork of the manager whose memory is that chain's assignments, reports and attached topic pages, and not the manager's wiki or in-tray. It talks as that fork ("Pix 3, on the deck work") and can't `assign`.

That conversational fork is the one new capability here (a variant of `oneOnOneTarget`). It costs the building's directed bucket, because a human opened it.

**Lanes, grants, Bank.** Directed, from the building's pool. No tree change.

## Kanban: the queue as a board

**What.** The building queue drawn as four columns:

- **Queued**: `pending`, not held, in queue order.
- **Held**: `pending` with a `heldReason` or an unmet `waitFor`, showing the reason ("grant at checkpoint", "waits for deploy 02f1bbe").
- **Running**: `active`, with the fork or resident and its live adjusted tokens.
- **Done**: `done` and `cancelled` in the last 24 h, each linking to its report.

Cards show the title, lane chip, grant or KR, and age. The **WIP limit is the building's desks** (`headcount`; forks take free desks, `forks.ts` `freeDesks`). The Running column header reads "3 / 6 desks". Nothing is enforced that isn't already enforced.

**Where.** A **Queue** tab on the building panel (beside Schedule), and the **Queue** tab on a goal node, which rolls the boards of every building attached in the subtree into one, with building swimlanes. The node board answers "what is happening under this goal right now" without opening a building. Read-only: there is no drag to reorder, since the queue order is the manager's.

**Lanes, grants, Bank.** It is a view over `assignments`, with no schema change. Mitchell's caution applies: the board is a picture of the queue, not a ceremony. It has no sprints, no WIP policies beyond desks, and no standups. The morning and evening review with small assignments is the iteration.

## The planning agent

**Plan with an agent** opens a 1:1 between the human and **Planner**, a Town Hall resident. Planner belongs to no building's subtree. Its sessions are `directed`. Who pays is open question 1.

- **Its first prompt.** The whole tree (statuses, due dates, owners, attachments, grant spend), every dial with 8 weekly points, an event digest since the human's last review, each building's latest rollup, and the open proposals. Started from a goal row, it is scoped to that subtree.
- **What it does.** It drafts nodes as `goal_proposals`. They show inline in the 1:1 as cards with Accept / Edit / Cut, and anything undecided stays in the Proposals strip. It never edits the tree. It also facilitates reorg meetings.
- **First jobs:**
  - draft `promote` proposals for the 12 met KRs that were really standing goals;
  - date every migrated KR;
  - propose one dial-target KR for each of Fund, Join and Trust.

## Review cadence and the deck

**No scheduled meetings except the reorg meeting.** Mitchell's morning and evening review is the cadence.

- **The deck** (kr_2qg0ayfs1j):
  - **Slide 1, the state of the town**: the three dials, past-due KRs, and tree changes since your last review.
  - **One slide per KPI dial**: the dial's 8 weekly points as a line (`GET /api/kpis` already returns them), with this week vs last week, then every open KR targeting it (target, due, distance to go, its grant and spend) and the goals watching it. A dial with no KR targeting it says so: "Nothing targets Join." That is the cue to ask Planner for one. Dial slides come before decision slides because they are context, not decisions. They are as many as there are dials (3 today).
  - **Decision slides**: checkpoints, grant proposals, reorg items (under-review KRs), then goal proposals. Within that order, items that block the most come first.
  - The deck shows only "Mine" items when more than one human owns nodes.
- **More than one human.** Owners route items (see Owners). Each human has their own `lastReviewedAt`. An item decided by another human disappears from your in-tray, and the next deck notes "decided by Lena".
- **Meetings, three uses only:**
  1. the **reorg meeting** (the only scheduled kind);
  2. a **1:1** with a manager, a skip-level resident, or an agent, as today;
  3. **Plan with an agent**.

  Today's building cadence meetings (standup, retro, planning) go. Everything routine stays asynchronous in the in-tray.

## What gets removed or changes

- **Planning map**: loses goal display and editing. It keeps placement plus one line, **Attached to: [goal chips] · Attach…** (admins).
- **Building Goals tab**: a read-only view of the building's subtree(s), with "Edit at the Town Hall →" and a **Propose a key result** form for the manager. The KR editor, Mark met/missed and Delete move to the editor.
- **Objectives become goals.** `set_objective` goes. `GET /api/buildings/:id/objectives` returns the subtree in the old shape for one release.
- **`buildings.goal`** stays as the building's one-line **Purpose** (door, prompts).
- **Untouched**: grants, checkpoints, the Bank (unless budget by node is approved), member funding, lanes' gate logic and the stoplight.

## Migration (one additive migration; its number is checked against main right before merging, 061 at the time of writing)

1. Create the tables `goals`, `building_goals`, `goal_proposals` and `goal_changes`. Add the new `key_results` columns. Add `goals.edit` to the admin role.
2. Seed the root `gl_town` (owner: the town admins), and under it `gl_fund`, `gl_join` and `gl_trust`, watching `kpi_fund`, `kpi_join` and `kpi_trust`.
3. Turn every objective into a goal with the **same id**, under its KPI goal (or under the root if it has none). Its KRs get `goalId = objectiveId`, and its building is attached to it.
4. Give each building with **unsorted KRs** a goal `gl_<buildingId>` (its goal line, under the root). Those KRs go under it, and the building is attached to it.
5. Archive KRs that are `met` or `missed` (`archivedAt = updatedAt`). Nothing touches `grants`.

Live numbers (2026-10-30, commit 02f1bbe):

| Building | Objectives → goals | KRs under objectives | Unsorted → `gl_<id>` | Archived | Funded grants |
|---|---|---|---|---|---|
| Town Workshop | 3 | 5 | 0 | 0 | 2 (gr_iq5m7dug56, gr_tvt32g9xly) |
| Prod | 2 | 5 | 3 | 3 | 2 (gr_rntk0echpi, gr_8cdix9mpye) |
| Code Legibility and Maintenance | 1 | 3 | 5 | 4 | 0 |
| Onboarding | 0 | 0 | 6 | 1 | 0 |
| Bank Transparency | 0 | 0 | 4 | 4 (all) | 0 |
| UI / UX | 0 | 0 | 0 | 0 | 0 |

The result:

- **14 goals** (the root, 3 KPI goals, 6 from objectives, 4 per-building), **31 KRs** (19 open, 12 archived), and 27 grants unchanged.
- **Two buildings come out blocked.** Bank Transparency has no open KR. UI / UX has nothing to attach.
- **The root is the only owned node**, so every route ends at Mitchell, as today.

The migration doesn't guess structure: no merging per-building goals into Fund/Join/Trust, no promotions. That cleanup is Mitchell's, in the editor, with Planner's drafts. The old columns stay, unread, until a later migration drops them; that rollup's "Your call" would say so.

## Build order (after this doc is approved)

1. **Core.** The migration; the `Goals` service (tree, `inScope`, edit, attach, owners and owner routing, proposals); the scope switch in `grants.ts` / `lanes.ts`; routes, verbs and the desk brief. Core tests check scope, owner routing and a lossless migration (every KR id, status and grant survives).
2. **The Town Hall editor**, with Owner and the Subtree tab, plus the read-only building Goals tab and the map's attachment line.
3. **The in-tray and the deck**: goal proposals, "Mine / All", the per-user review marker, and the KPI dial slides.
4. **Change this goal**: `goal_changes`, under-review KRs, the reorg meeting, and Planner. Planner is needed here as the facilitator, and Plan with an agent ships with it.
5. **Postmortems** on missed KRs, and the **Kanban** Queue tabs (building and node).
6. **Skip-level 1:1s**, with the conversational fork session.
7. **New dials** (collectives this month, visitor first sessions that finish work).

Not in the order: **budget by node**. Its read-only Spend tab can join step 3 if wanted. Allocation by node is a Bank change and waits for Mitchell's yes.

## Open questions for Mitchell

1. **Planner: who pays?** The Town Hall draws nothing today. Should it be a small Town Hall allowance, or the Workshop's directed bucket?
2. **Dial-target KRs: auto-claim?** When a dial crosses a KR's target, should the town set the KR to `claimed` on its own (you still mark it met)?
3. **Retiring a goal with open KRs or a funded grant.** Should that be refused until they close, or should the open KRs archive as missed while funded grants finish?
4. **Must every goal sit under Fund / Join / Trust**, or may one hang off the root?
5. **New buildings**: start unattached and blocked, or must the map require an attachment at creation?
6. **What owners can do.** Is subtree-scoped `goals.edit` enough, or should an owner also fund grants under their node (`building.fund` scoped to the subtree)? And should a node be allowed an agent owner yet?
7. **Reorg meeting date.** Is at least 24 h ahead right? Should a reorg on a node with no attached buildings skip the meeting and apply at once?
8. **Skip-level with forks.** Is a conversational fork session (a fork speaking for one recent chain) acceptable, or should skip-levels pick only named residents and say "no one to talk to" when a subtree is all forks?
9. **Budget by node.** Do you want allocation by node at all, or only the read-only Spend tab?
