# Goals: one town-level goal tree

Status: **approved; build step 1 under way** (Mitchell in 1:1 mt_kh0zaqui0w: "i don't need a read, i think we're good"). Decided in 1:1 mt_a3nvwfawer (2026-10-30, decision 1). First pass by Pix 2 (as_s5zqdgk3zi). The second pass, by Pix 1 (as_bb0wrwf0v7), adds owners, "Change this goal", KPI slides, skip-levels, postmortems and the kanban view. The third pass (Pix 1, as_9srttx6zen) rewrites finance around 1:1 mt_529jbnwvmi decision 1: one Bank balance, desks as the steer, streams and earmarks, free funds for exploration. The fourth pass (Pix 1, as_hjwljl7eb8) folds in 1:1 mt_kh0zaqui0w: the map is drawn from the tree (§ "The map is the tree"), no KPIs for now, one root with placeholder children and unbounded depth, exactly one attachment per building, retiring moves open KRs to a sibling, and a UI inventory. The fifth pass (Pix 1, as_3chyvmzlf8) folds in the rest of mt_kh0zaqui0w: owners decide and fund grants in their subtree, the reorg meeting opens when the prep reports are in (or after 24 h), skip-levels are dropped for now, and one key per session is confirmed with a donor warning and an unused-donation alert. Only the two map questions stay open. Until this is built, today's model holds: per-building objectives and key results, described in `docs/goal-directed-budgets.md` ("Objectives and KPIs", migration 043).

## Why

Today each building owns its own goal, objectives and key results. The only thread between buildings is a KPI label (fund, join or trust) on each objective. To learn what a building is doing, or to steer it, Mitchell has to visit it and talk to its manager. Goal editing sits on the planning map, where it doesn't belong. And a met key result quietly stops new grants, even when the direction behind it should stay: some met KRs were really standing goals.

The fix is the move the Bank already made: goals come out of buildings. There is **one goal tree for the town**, edited at the Town Hall, and **each building attaches to one node** of it. The map is drawn from the tree.

A note on scope. Mitchell observed that this is turning into an org/corporation sim. It borrows only what the town needs: a captain per node, one reorg action, and a board view of the queue. It takes no lean, agile or waterfall ceremony. There are no sprints, standups, retros or scheduled planning. **The iteration is Mitchell's morning and evening review, plus small assignments in between.** The one scheduled meeting the tree needs is the reorg meeting (§ "Change this goal").

## The model in one picture

> Superseded by [how-work-gets-done.md](how-work-gets-done.md) §4: key results move from goals onto grants; goals keep none of their own.

## Data model

Everything is additive (see Migration). Ids stay stable: every `kr_…` keeps its id, statuses and grants, and every `ob_…` objective becomes a goal with the same id.

- **`goals`** (new): `id` (`gl_…`, or the old `ob_…`), `parentId` (null only for the root), `position`, `text` (≤300 chars), `ownerId` (nullable; see Owners), `status` (`active` | `retired`), `retiredAt/By/Note`, `createdBy`, `editedBy`, `sourceDocIds`, `createdAt`, `updatedAt`.
- **`key_results`** (existing) gains nullable columns: `goalId`, `due` (an ISO date; required for new KRs), `archivedAt`, `underReviewSince` (set by a reorg), `postmortemDocId`. `status`, `statusNote` and `statusBy` stay as they are. The old `buildingId` and `objectiveId` stay in place: they are written as the proposing building and read by nothing.
- **`buildings.goalId`** (new nullable column; nullable only so the migration is additive): the one goal the building is **attached** to. **Every building has exactly one attachment** (1:1 mt_kh0zaqui0w): it is set at creation (default: the root), editable in building settings, and never unset; the service refuses a null. A building's **subtree** is its goal and everything under it. Several buildings may share a goal. One attachment is also what the map needs: a building stands in one place (§ "The map is the tree"). Attach changes are events (`goal.attached`), so no history table.
- **`goal_proposals`** (new): `id` (`gp_…`), `action` (`add-goal` | `add-kr` | `edit` | `move` | `retire` | `promote`; promote turns a KR into a goal), `targetId`, `parentId`, `fields` (JSON), `why`, `proposedBy`, `buildingId`, `reorgId` (nullable), `sourceDocIds`, `status` (`open` | `accepted` | `cut` | `superseded`), `decidedBy/At`, `note`.
- **`goal_changes`** (new, the reorg): see "Change this goal".
- **History is the event log.** Every change appends an event with the actor and a before/after payload: `goal.created / edited / moved / retired / owned / changed`, `kr.created / updated / archived / under-review`, `goal.attached`, `goal.proposal`. Agents read these events (`GET /api/goals/:id/history`, the Planner's event digest); the web shows no history, not even a "last changed" line (1:1 mt_n25udpflus decision 5: agents care about the changelog, humans don't). There is no audit table.

**Grants** keep `keyResultId` and `buildingId`. Only the scope check changes. Today the KR must belong to the grant's building (`grants.ts` `requireGoalKeyResult`, `lanes.ts` `resolveLane`). After the switch, the KR must be **open (not archived) and in the building's subtree**: one helper, `Goals.inScope(buildingId, krId)`. The grant's building still does the work, and the Bank pays by draw order (see Finance).

## Who can change the tree

> Superseded by [how-work-gets-done.md](how-work-gets-done.md) §4: `propose_key_result` and KR status on goals go; managers propose grants (with their key results) and goals.

Today: humans with `goals.edit` (town admins, and a node's captain on their subtree) edit the tree; managers and their forks propose goals (`propose_goal`) and grants with their key results (`propose_grant`).

## The Town Hall goal editor

There is a new place in the Town Hall, the **Goal tree** (a wall chart by the in-tray). It opens a large sheet over the map (not the side panel; UX pass dc_yn8gl1rmyt) with two columns:

1. **Tree** (left): a grab-able canvas drawn like a textbook tree (1:1 mt_cyd2t5ioob decisions 4-6; `GoalCanvas.tsx`, layout in `goalCanvas.ts`). The root box sits at the top, each goal's children in a row beneath it, joined by elbow lines; a parent is centred over its children's row so subtrees never overlap. Drag empty canvas to pan, wheel or pinch (or − / +) to zoom, Fit or a double-click on empty canvas frames the tree; a ?goal= link centres its box. Each box: the goal's words (three lines), its subtree's desks, a 👤 captain badge when the goal has its own captain, "n KR · m funded", "n late" (or the nearest due), "n proposals", then one row per attached building with its desks; an admin (town.manage_buildings) gets − / + beside each to change that building's desks in place (a lower count only stops new forks; running ones keep their desks and the lab shrinks as they free). ▾ / ▸ under a box collapses its subtree (a count shows what is hidden). Dragging a box onto another moves it there after a confirm (the Move rules). Arrows walk the tree (up parent, down first child, left/right along the row), Enter jumps to the detail. The toolbar has a building filter (and Funded by me) and Retired. Key results are in the detail, not on the canvas.
2. **Node detail** (right). The path, the goal's words, captain and attached buildings, then a toolbar for admins and the node's captain: Edit words, + Goal under it, + Key result, Move, Captain, Change this goal, Retire. Each opens its form in place. Then the **Proposals** waiting at this goal or below (all of them at the root), each with the change in context (the parent path, old → new, who proposed it and why) and **Accept**, **Edit and accept**, **Cut** (its note goes back to the proposer as a mention). The same proposals show in the in-tray and the review deck. Then the key results as cards (status, funded / open, due, the words, how to check; Met / Missed, or Keep / Move / Archive when under review). Everyone else gets the same detail read-only. The detail has no tabs (1:1 mt_n25udpflus decision 5 dropped History, Subtree, Spend and Queue): a goal's spend is the Bank's **Spend by goal** (Spending tab, see Finance), the queue is each building panel's **Queue** tab, and the goal's history is for agents through the API, not the UI.

**Talk to the Planner** (top right) opens the human's 1:1 with Planner (below) in the side panel, beside the sheet: the sheet stays open while the side panel shows a 1:1, a grant or a building opened from it. Its × closes it, and so does Esc when no side panel is open. Guests and members see the whole tree read-only. It is the town's public answer to "what is this place trying to do".

## The map is the tree (1:1 mt_kh0zaqui0w)

**What.** Building organization on the map is **generated from the goal tree, roads and all**. Nobody places buildings by hand.

- **The Town Hall sits at the root**, above the main street; the Bank stands below it, at the street's west end.
- **Only goals with a building under them draw** (Mitchell, 1:1 mt_wql34b8gkl: "we don't need an empty lot for every unassigned goal"). The goal tree at the Town Hall still lists every goal. A goal with no building of its own and one drawn child folds into that child, so a chain of goals is one step, not a long walk.
- **No plaza per building**: a building stands right on its parent goal's street, its door on it, one tile of grass between neighbours ("pack the buildings together so that it actually feels like a town").
- **A goal with drawn children gets a street** one row below its parent's, joined by a one-tile drop, with a signpost carrying the goal's text beside the drop. Its children's buildings and blocks hang off that street. The goal is a place (`plaza:<goalId>`, on its street below the signpost; for a goal without drawn children, its first building's doorstep), so agents can `go` there.
- **Walking from the Town Hall to a building walks down the tree**: main street → the drop to a goal's street → the door.
- **Archived KRs and retired goals don't draw.** KRs are not on the map at all.
- **Three shapes, one town-wide setting** (`town.mapLayout`, 1:1 mt_q10xf3bkoq; mocks dc_fvgi5nq36j): **fountain** (each first-level goal's street is a three-row plaza with a fountain, its children's buildings and streets on the plaza's rim), **tree** (the packed layout above) and **radial** (the Town Hall and the Bank in a ring road in the middle, each first-level goal a spoke: a hub with its signpost, its buildings on an arc beyond; core `world/radial.ts`). An admin or a goal captain picks it on the town map (`PUT /api/town/map-layout`); everyone sees it, the map redraws at once and the pick is logged. A new collective starts as fountain; the Workshop was kept on tree by migration 070 until Mitchell picks.

**What goes.** Human drag placement on the planning side bar goes: no dragging buildings, no drawing new ones on grass, no drag-resize. Today's free placement plus derived roads (PR #83, `road.ts` `deriveRoads`, `layout.ts` `computeLayout`, `plan.ts` `validatePlan`) becomes **the renderer for the tree layout**: a new `treeLayout(goals, buildings)` computes every lot and plaza, and the existing code draws the grid and checks it. `deriveRoads` changes from "each door to the nearest road" to "each plaza to its parent's plaza, each door to its own plaza", with the same Dijkstra and turn cost.

**What changes with it.**

- **Size comes from desks.** Today desks follow floor space and a human resizes the lot on the map table. With no drag, the building's **Desks** setting becomes the editable number, and the lot size follows it (`sizeFor`, `labSize`).
- **Creating a building** happens at the planning desk's Buildings form, which gains a **Goal** picker (default: the root). The layout places it.
- **Any tree change redraws the map**: add, move or retire a goal, attach a building, or a reorg's accepted proposals. The server recomputes the layout and pushes the new grid. Bodies inside a moved building move with it; bodies outdoors re-path along the new roads (the walk-home fix of PR #120 already re-paths a body whose walk was cut off).

**Consequences.**

- **Exactly one attachment per building.** A building can stand in only one place. This replaces "a building attaches to one or more subtrees" everywhere in this doc, and it fits the rule that a building is never unattached.
- **A stable, packed layout.** Children are laid out in a fixed order (`position`, then `createdAt`), never re-sorted. Blocks sit side by side with one tile of grass between them (no slack bands since 1:1 mt_wql34b8gkl), so adding a building shifts only the blocks after it, right and in order; bodies inside follow their desks. The same tree always gives the same map (no randomness).
- **Map bounds.** A wide or deep tree can outgrow today's limits (`MAX_TOWN_X` 240, `MAX_TOWN_Y`). The layout grows the map rather than refusing; those constants become derived.

**Open (for Mitchell).**

1. ~~What an empty goal node looks like~~: answered in 1:1 mt_wql34b8gkl, nothing draws until a building attaches.
2. ~~Long walks on deep trees~~: answered in 1:1 mt_wql34b8gkl by packing; a chain of goals with no buildings folds into one step. The overall shape (tree, radial, plazas grouping related buildings) is for the vision doc.

**Build.** Step 2, right after the core (see Build order).

## Captains on nodes

**Captain** is what the town calls a goal's owner wherever a human reads it (Mitchell, 1:1 mt_3jtclcoxl2, 2026-10-31: "owners are captains"). Code and API keep the old word: the column `goals.ownerId`, the tree's `owner` field, the `goal.owned` event.

**What.** Any goal may have an `ownerId`: a human user, and only humans for now (1:1 mt_kh0zaqui0w; managers propose). The field is an agent-or-user id, so an agent can own a node later without a migration. Ownership inherits: a node with no owner belongs to its nearest owned ancestor. **The root always has a captain** (1:1 mt_cyd2t5ioob decision 7): it is seeded with the collective's first admin user (the earliest admin with a GitHub account, else the earliest admin: Mitchell on muster.town, the founder on a hosted collective; migration 078 back-filled it), `Goals.ensure()` repairs a root with none at every boot, and it can be handed to another user but never cleared. So every goal has a captain and `Goals.ownerOf` always returns a user. **The org chart is derived, not declared:** an owner's reports are the managers of the buildings attached in their subtree, and their own manager is the owner of the nearest owned ancestor. The UI draws it as the tree, filtered to owned nodes.

**Routing.** Every Town Hall item routes to the captain of the node it belongs to:

- a **grant proposal or checkpoint** belongs to its KR's goal;
- a **goal proposal** belongs to its target or parent node;
- a **rollup** belongs to the building's attachment;
- a **captain request** belongs to the goal asked about (the root too).

There is no "town admins" fallback: the root's captain is a user like any other, so an item that ends at the root routes to that person. The Town Hall in-tray stays one queue: each human sees **"Mine"** (items routed to them, nothing else: an admin who captains nothing has an empty Mine) and **"All"**. Admin is permission, not routing: admins still decide and fund anywhere (`building.fund`, `goals.edit`). The first human to decide an item clears it for everyone, as the per-user review marker already does. With one human, every route ends at Mitchell and nothing changes. With several, the in-trays split by subtree, which answers the multi-human review question without a meeting.

**Permissions** (1:1 mt_kh0zaqui0w). An owner holds `goals.edit` scoped to their subtree: they can edit, accept proposals, mark met/missed, attach, and set owners below them. An owner also **decides and funds grants** whose KR sits in their subtree: `building.fund` scoped to the subtree, so funding is no longer admins-only. Funding by a plain member from their own input (kr_6f9c200vsx, gr_tvt32g9xly) is unchanged. Admins keep both powers everywhere.

**UI** (as designed; the Subtree tab was built in step 3 and dropped in 1:1 mt_n25udpflus decision 5, so today the tree itself is the captain's view). The node page's **Subtree** tab was the captain's rollup of rollups:

- every attached building's last rollup line and stoplight;
- open KRs by due date;
- grants with spend against their ceilings;
- what is waiting on the captain.

The building panel's Overview names the captain once ("Captain: <captain>", linking to the goal in the tree) under the goal card, since the attached goal is the building's purpose.

**Asking to captain a goal** (built: grant gr_bwm0iz7rwl, kr_j1w17nw178; "captain" is the word humans see for the owner). A signed-in member (`town.interact`) who can't edit a goal presses **Ask to captain this goal** in its detail in the goal tree, with an optional line on why. The ask (`goal_captain_requests`, ids `cr_`, migration 071) is a Town Hall in-tray item, counted in the badge, with its own section ("Asking to captain a goal") and a review-deck slide. It routes like everything else here: to the goal's current captain (its own or inherited; the root always has one). Whoever holds `goals.edit` at the goal (that captain, a captain above, an admin) presses **Accept**, which sets `ownerId` through the same path as the Captain tool and posts `goal.owned`, or **Decline**, which changes nothing; the member may ask again. One pending ask per goal and member; the root can be asked for like any node (accepting hands the root over). API: `POST/GET /api/goals/:id/captain-requests`, `POST /api/captain-requests/:id/decide` (`accept` | `decline`).

**Lanes, grants, Bank.** No Bank change. Captaincy routes review and scopes `goals.edit` and grant funding; a grant a captain funds draws from the Bank as any funded grant does.

## "Change this goal" (the reorg)

**What.** On a goal, an admin or the node's captain writes **X → Y** (the new text and a paragraph of why). That creates:

- **A `goal_changes` row**: `id` (`gc_…`), `goalId`, `fromText`, `toText`, `why`, `createdAt`, `meetingDeadline` (`createdAt` + 24 h), `meetingId`, `sourceDocId`, `status` (`prep` | `meeting` | `decided`), `createdBy`, `decidedAt`.
- **A note doc** authored by the human ("Change this goal: X → Y", filed at the Town Hall). This is the human source for all the directed work below, so `lanes.ts` `humanSource` needs no change.
- **A planning meeting** (`kind: planning`, at the Town Hall). **It opens when every attached building's prep report (the report on its directed assignment, below) is in, or 24 h after the change was filed, whichever comes first** (1:1 mt_kh0zaqui0w). A node with no attached buildings has no prep to wait for, so its meeting opens at once. Its invitees are the owner(s) in the subtree and the manager of every building attached under the node. Planner facilitates: it is the Town Hall's manager (1:1 mt_wql34b8gkl).
- **One directed assignment per building** under the node, on its building queue, with source = the note: "Review your work against Y. Bring proposals for what goes underneath (`propose_goal` / `propose_key_result` with `reorgId`), and say which of your KRs and grants still serve Y."
- **"Under review" on every open KR under the node** (`underReviewSince`). The KR keeps its status, and its **grants keep running until a human cuts them**, through the prep window and the meeting. The tree, desk briefs and in-tray show a "under review" pill. A new grant proposal on an under-review KR is allowed but flagged.

**At the meeting.** The goal text becomes Y when the meeting starts. Each manager presents its proposals, and the human accepts or cuts them on the spot (Planner records each acceptance as a meeting decision). **The accepted proposals become the node's new children.** For each under-review KR, the human decides: **Keep** (clears the flag), **Move** (to another goal), or **Archive** (as missed). Grants on archived KRs go to the in-tray as Cut candidates. When the meeting ends, the change becomes `decided` and the map redraws from the new tree (new plazas, buildings moved to their new goals). KRs left undecided stay under review and get a deck slide each until they are decided.

**Why a meeting here, and nowhere else.** A reorg changes many buildings' work at once. Proposals from several managers have to be weighed against each other, and the in-tray handles one item at a time. Every other tree change is a single proposal.

**Lanes, grants, Bank.** The assignments are directed (human source = the note). Grants are untouched until a human cuts them. No money moves: the tree holds none. Effort moves with the buildings' desks, and an earmark stays on its node.

## Finance: one balance, streams, desks (decided in 1:1 mt_529jbnwvmi, decision 1)

**The tree says what matters; the Bank says how much there is.** The tree carries no money: no allocation by goal node, no budget tree, no `pct` on a goal. There is one Bank balance; **Bank pools are deleted** (built: as_1nuoiauxlw, migration 067; see "Free tokens" below). Nothing in the Bank needs to know about goals except an earmark's scope (below).

**Human review of grants stays.** Buildings scout and propose; a human funds or cuts; funded grants run. No grant starts itself. Autonomy lives in the scouting, not in the spending.

**Effort steering is desks.** A building attaches to a goal subtree, and its desks (`headcount`; forks take free desks) are that subtree's concurrency. More desks on a subtree means more sessions at once, so it spends faster. To steer, a human moves desks between buildings or attaches a bigger building to the subtree; that is what a VP does ("put more people on it"). Since a building has exactly one attachment, its desks steer exactly one subtree.

### Streams

- **A donation is a stream**: a lump sum, or N tokens a day; cash (a subscription or money) or an API key with a daily limit. Today's `BankInput` is nearly this already (`tokens`, `recurrence`, `weeklyCapTokens`, `hasApiKey`); a stream adds a nullable `goalId` and, for keys, `dailyLimitTokens`.
- **An earmark is a stream scoped to a goal node**: it only pays for sessions whose work sits in that node's subtree. A member funding one grant from their own input (gr_tvt32g9xly, `fundedWith`) is the narrowest case, a stream scoped to one grant.
- **Draw order, not a split.** The Bank pays each session from the **narrowest matching stream** (grant, then the nearest earmarked goal above the session's KR or goal, walking up), **then the general balance**. A session matches through its lane, the same attribution Spend by goal uses. When an earmark runs dry, the work continues on the general balance; nothing is held.

### Free tokens and the optional exploration cap (built: how-work-gets-done.md build step 1, as_1nuoiauxlw)

> The design is [how-work-gets-done.md](how-work-gets-done.md) §7 and §8 (1:1 mt_wql34b8gkl, the Bank sign-off). It replaced "free funds" (no week horizon: only what is in the Bank now, §12 q4) and the interim "pool and exploration budget on the goal" (migration 065).

**Pools are deleted.** One general balance (every credit not earmarked) that every building draws first come, first served (`Bank.available`, `drawTokens`); earmarks are the only per-subtree funding. Migration 067 is additive: `bank_pools`, `bank_debits.poolId`, `goals.poolId`, `goals.explorationTokensPerDay` and the buildings' copies stay, read by nothing. Gone from the code: `BankPool`, `DEFAULT_POOL_ID`, `Bank.listPools / poolOf / goalsIn / buildingsIn / shares / createPool / updatePool / deletePool / setGoalPool / poolAvailable / poolDailyInflow / pools`, core `finance-pools.ts`, `/api/bank/pools`, `/api/finance/pools`, the Bank's Pools tab, `goals.ts fundingAt / fundingOf`.

**Free tokens** (core `free-tokens.ts`: `freeTokens(world, goalId)`, `freeTokensAll(world)`), as coded:

```
claims  = funded/checkpoint grants' max(0, grantTokens − spent)   (goal: its key result's goal, else its building's attachment)
        + proposed/countered grants' askTokens                     (same goal)
        + open bank_reservations' tokens                           (their goalId)
each claim is paid like its sessions would draw: the nearest earmark at or above its goal first (walking up), the rest by the general balance
free(goal) = max(0, general balance − what the claims took from it) + what the claims left of the earmarks at or above goal
```

A funded grant's unspent tokens are its reservation (derived, as before). `bank_reservations` (goal, building, assignment, tokens, openedAt, closedAt, spentTokens) is empty until the declarative explore step (§3) opens them. Shown: `GET /api/goals` and `GET /api/goals/:id` `funding.free`, `GET /api/bank` `free` (the root's), the goal tree's Funding block, the Bank's Overview and its Free tokens tab (the fountain).

**Exploration has no allowance.** `explorationTokensPerDay`, `EXPLORATION_SHARE` and the "exploration allowance spent today" hold are gone. Exploration is held only when the free tokens under the building's goal are 0 ("held: no free tokens under its goal") or an optional cap is reached: `Goal.exploreCapTokensPerDay` (null = inherit; none up the tree = uncapped; the root's is town-wide), set with `PATCH /api/goals/:id {exploreCapTokensPerDay}` by a human funder with `goals.edit` there (an admin or the goal's owner, never an agent); the cap counts today's (UTC) lane-exploration sessions of the buildings at or under the capping goal, plus reservations opened there today. Directed work is never held for money. The board's `exploration` is `{spentTodayTokens, freeTokens, cap}`.

### Sessions and keys

- **A session runs on one desk with one auth.** No key swap mid-session: the prompt cache is per key, so a swap throws the cache away and re-bills the whole context.
- **A key stream is picked at session start only if it covers a whole session's expected cost.** The expected cost comes from real session sizes in the Bank: the last 89 finished work sessions (2026-10-29 20:50Z to 2026-10-30 19:30Z) were p50 43k, p90 120k, max 337k adjusted output tokens. A first rule: the building's p90 over the last 7 days. **A smaller stream accrues** (its unspent income stays on its ledger) until it covers one.
- **One key per session stays** (confirmed in 1:1 mt_kh0zaqui0w). A donated key whose daily limit is below one session's expected cost (the building's p90 over 7 days) **never runs a session alone; it accrues.**
- **Warning at donation time.** When a key's daily limit, or a lump or daily amount, is below one session's expected cost, the Donate form says so before the donor confirms: "your key covers no whole session yet" (with the current p90 and how many days it takes to accrue one).
- **Alert for chronically unused donations.** A stream with no draw for N days (7 to start) raises an alert: an **in-town notice to the donor** and a line on the funder's deck slide ("no session has run on this for 7 days", with the reason: below one session, or out of scope). The server sends no email or SMS itself (c45eaeb: Wright's VPS pinger is the single outside alert path), so an email or text to the donor goes **via the pinger, not the server**, if wanted. Emails to donors via Resend come eventually, not now (Mitchell, 1:1 mt_kh0zaqui0w).
- **The desk gets a cap with the key**, so the fork stops cleanly (reports or parks) before the API cuts it off mid-call. Sessions are already metered per session; the cap is the stream's remaining limit, in adjusted output tokens.

### Funder attribution: one deck, two filters

- **Key donors get the literal story**: these sessions ran on your key, and here is what they did (each session's assignment, report and KR).
- **Money donors get the pro rata story**: your share of the week's general-balance draws, and what the week bought. An earmark donor's story is literal within their node.
- **Same review deck** (kr_2qg0ayfs1j), different filter: "for funder X, this week".
- **A held key is a stored secret** (`docs/secrets.md`): encrypted at rest, its usage shown to its donor, and revocable at any time; revocation stops new sessions on it, and a running session finishes under its cap.

### Spend by goal (read-only, no Bank change)

The Bank's **Spend by goal** section (Spending tab; a tab on every node until 1:1 mt_n25udpflus decision 5 moved it to the Bank) shows a goal's subtree spend, read from session bookings (`sessions.adjustedOutputTokens`, with lane, grant and KR), by week and by lane, next to the results: KRs met or missed over the same weeks. A session belongs to a node by its lane: `grant` → the grant's KR's goal; `exploration` or `directed` naming a KR or goal → that node; anything else → the building's attachment. It can ship with step 4.

**Bank changes, gated on Mitchell** (town-wide rule dc_vzqoh7ppen): dropping pools, streams with scopes and the draw order, free funds replacing the exploration allowance, per-session key caps. They are build steps 7 and 8 below and wait for his yes on the code, even though the design is decided.

## How lanes map onto subtrees

> Superseded by [how-work-gets-done.md](how-work-gets-done.md) §3 and §4: exploration names a goal, not a key result; "blocked: no KRs" and the KR stoplight go.

## Postmortems on missed KRs

**What.** When a human marks a KR **missed**, the dialog asks for a line on why. That line is filed as a note by the human, and the note is the human source. Marking it missed then queues **one directed assignment** on the building queue of the building whose grant named the KR (or, failing that, the building that proposed the KR): "Postmortem on kr_…: what we planned, what happened, what we'd do differently, and whether the goal needs a new KR. One screen. No new work." The assignment is capped small (stop condition: one report). Its report is filed with `postmortemOf = kr_…`, and the KR's `postmortemDocId` points to it. Two postmortems are never queued for one KR. A KR archived by a reorg as missed gets one too.

**UI.** In the editor, the archived "✗ missed" row opens its postmortem. The report also reaches the manager's in-tray, as any report does. If it ends with a KR proposal, that proposal lands in the Proposals strip.

**Lanes, grants, Bank.** The work is directed (a human marked it missed). Its spend shows in the Bank's Spend by goal under the KR's goal. Nothing is queued for met KRs.

## Skip-level 1:1s: dropped for now

Dropped in 1:1 mt_kh0zaqui0w: Mitchell 1:1s managers directly. A possible later addition: a "Talk to a resident under this goal" button on a node, with a conversational fork session (a fork of the manager speaking for one recent chain) when the subtree has no named resident.

## Kanban: the queue as a board

**What.** The building queue drawn as four columns:

- **Queued**: `pending`, not held, in queue order.
- **Held**: `pending` with a `heldReason` or an unmet `waitFor`, showing the reason ("grant at checkpoint", "waits for deploy 02f1bbe").
- **Running**: `active`, with the fork or resident and its live adjusted tokens.
- **Done**: `done` and `cancelled` in the last 24 h, each linking to its report.

Cards show the title, lane chip, grant or KR, and age. The **WIP limit is the building's desks** (`headcount`; forks take free desks, `forks.ts` `freeDesks`). The Running column header reads "3 / 6 desks". Nothing is enforced that isn't already enforced.

**Where.** A **Queue** tab on the building panel (beside Schedule). The goal node's Queue tab (every building attached in the subtree as a swimlane) was dropped in 1:1 mt_n25udpflus decision 5; `GET /api/goals/:id/queue` still answers it for agents. Read-only: there is no drag to reorder, since the queue order is the manager's.

**Lanes, grants, Bank.** It is a view over `assignments`, with no schema change. Mitchell's caution applies: the board is a picture of the queue, not a ceremony. It has no sprints, no WIP policies beyond desks, and no standups. The morning and evening review with small assignments is the iteration.

## The planning agent

**Plan with an agent** opens a 1:1 between the human and **Planner**, a Town Hall resident and the Town Hall's manager (`managerAgentId`, set by `ensurePlanner`; migration 066 back-filled it; 1:1 mt_wql34b8gkl). It manages in name only: `managerAgentOf` leaves the Town Hall out, so the Town Hall in-tray stays the humans', the Planner gets no Town Hall manager role, no forks and no manager brief, and its agent panel's Talk to ★ Planner opens this same 1:1. Planner belongs to no building's subtree. Its sessions are `directed` and paid by draw order like any session (mt_529jbnwvmi decision 1).

- **Its first prompt.** The whole tree (statuses, due dates, captains, attachments, grant spend), an event digest since the human's last review, each building's latest rollup, and the open proposals. Started from a goal row, it is scoped to that subtree.
- **What it does.** It drafts nodes as `goal_proposals`. They show inline in the 1:1 as cards with Accept / Edit / Cut, and anything undecided stays in the Proposals strip. It never edits the tree. It also facilitates reorg meetings.
- **First jobs:**
  - draft `promote` proposals for the 12 met KRs that were really standing goals;
  - date every migrated KR;
  - turn Mitchell's "Standing goal?" answers in the KR inventory (dc_io1ry1ryjz) into proposals.

## Review cadence and the deck

**No scheduled meetings except the reorg meeting.** Mitchell's morning and evening review is the cadence.

- **The deck** (kr_2qg0ayfs1j):
  - **Slide 1, the state of the town**: past-due KRs, KRs due this week, and tree changes since your last review. No dials and no per-dial slides while KPIs are parked (1:1 mt_kh0zaqui0w).
  - **Decision slides**: checkpoints, grant proposals, reorg items (under-review KRs), then goal proposals. Within that order, items that block the most come first.
  - The deck shows only "Mine" items when more than one human captains nodes.
  - **A funder filter** (see Finance): the same deck for one funder's week. A key donor sees the sessions that ran on their key; a money donor sees their pro rata share of the week.
- **More than one human.** Owners route items (see Owners). Each human has their own `lastReviewedAt`. An item decided by another human disappears from your in-tray, and the next deck notes "decided by Lena".
- **Meetings, three uses only:**
  1. the **reorg meeting** (the only scheduled kind);
  2. a **1:1** with a manager or an agent, as today;
  3. **Plan with an agent**.

  Today's building cadence meetings (standup, retro, planning) go. Everything routine stays asynchronous in the in-tray.

## What gets removed or changes

- **Planning map**: loses goal display and editing, and loses drag placement too: the map is drawn from the tree (§ "The map is the tree"). Selecting a building shows **Attached to: [goal] · Change…** (admins), its budget and its stats.
- **Building Goals tab**: a read-only view of the building's subtree(s), with "Edit at the Town Hall →" and a **Propose a key result** form for the manager. The KR editor, Mark met/missed and Delete move to the editor.
- **Objectives become goals.** `set_objective` goes. `GET /api/buildings/:id/objectives` returns the subtree in the old shape for one release.
- **`buildings.goal`** stays as the building's one-line **Purpose** (door, prompts).
- **Bank pools and the per-building exploration allowance go**: done (how-work-gets-done.md build step 1, as_1nuoiauxlw; see "Free tokens and the optional exploration cap").
- **Untouched**: grants, checkpoints, human review of grants, member funding (it becomes a grant-scoped stream in step 7), lanes' gate logic and the stoplight.

## Migration (one additive migration; its number is checked against main right before merging, 061 at the time of writing: main's highest is 060)

1. Create the tables `goals`, `goal_proposals` and `goal_changes`. Add `buildings.goalId` and the new `key_results` columns. Add `goals.edit` to the admin role.
2. Seed the root `gl_town` (captain: the collective's first admin, migration 078), and under it the placeholders `gl_fund`, `gl_join` and `gl_trust` (no dials). A hosted collective's tree is its founder's (gr_5ltmbf3a2f): its root carries the Start form's goal (`ensureRootText`, the seed replaces the placeholder "The town goal"), and on every boot it deletes each placeholder pillar nobody has touched (`dropPlaceholderPillars`: seeded words, no captain, never edited, nothing filed against it); the Workshop keeps them.
3. Give **every building** a goal `gl_<buildingId>` (its goal line, under the root) and attach the building to it. That makes exactly one attachment per building, including UI / UX, which has no KRs.
4. Turn every objective into a goal with the **same id**, under its building's `gl_<buildingId>`. Its KRs get `goalId = objectiveId`. A building's unsorted KRs go directly under its `gl_<buildingId>`.
5. Archive KRs that are `met` or `missed` (`archivedAt = updatedAt`). Nothing touches `grants`.

Objectives go under their building's goal, not under Fund/Join/Trust by their KPI label, because the Workshop's three objectives carry three different labels and a building gets one attachment. So on day one Fund, Join and Trust are empty plazas, and the map shows six building goals off the root. **The sorting is Mitchell's**: the KR inventory, **dc_io1ry1ryjz** (all 31 KRs the town has had, with a blank "Standing goal?" column), is where he decides which met KRs become standing goals and where each belongs. Planner turns his answers into `promote` and `move` proposals.

Live numbers (2026-10-30, commit 02f1bbe):

| Building | Objectives → goals | KRs under objectives | Unsorted (under `gl_<id>`) | Archived | Funded grants |
|---|---|---|---|---|---|
| Town Workshop | 3 | 5 | 0 | 0 | 2 (gr_iq5m7dug56, gr_tvt32g9xly) |
| Prod | 2 | 5 | 3 | 3 | 2 (gr_rntk0echpi, gr_8cdix9mpye) |
| Code Legibility and Maintenance | 1 | 3 | 5 | 4 | 0 |
| Onboarding | 0 | 0 | 6 | 1 | 0 |
| Bank Transparency | 0 | 0 | 4 | 4 (all) | 0 |
| UI / UX | 0 | 0 | 0 | 0 | 0 |

The result:

- **16 goals** (the root, 3 placeholders, 6 per-building, 6 from objectives), **31 KRs** (19 open, 12 archived), 6 attachments (one per building), and 27 grants unchanged.
- **Two buildings come out blocked.** Bank Transparency has no open KR (all 4 archived). UI / UX has none at all. Each manager is woken once to propose a KR.
- **The root is the only captained node**, so every route ends at Mitchell, as today.

The migration doesn't guess structure: no moving per-building goals under Fund/Join/Trust, no promotions. That cleanup is Mitchell's, in the editor, with Planner's drafts. The old columns stay, unread, until a later migration drops them; that rollup's "Your call" would say so.

## Build order (after this doc is approved)

1. **Core.** The migration; the `Goals` service (tree, `inScope`, edit, attach, owners and owner routing, proposals, retire with move-to-sibling); the scope switch in `grants.ts` / `lanes.ts`; routes, verbs and the desk brief; attachment required at building creation (default: the root). Core tests check scope, owner routing, "a building is never unattached" and a lossless migration (every KR id, status and grant survives). **Built** (as_6zx9zmtvdo): migration 061, `packages/core/src/goals.ts`, REST `packages/server/src/routes/goals.ts` (`GET /api/goals`, `/api/goals/:id`, `POST /api/goals`, `PATCH /api/goals/:id`, `POST /api/goals/:id/retire`, `POST /api/goals/:id/key-results`, `PUT /api/buildings/:id/goal`, `GET /api/buildings/:id/scope`, `GET/POST /api/goal-proposals`, `POST /api/goal-proposals/:id/decide`), verbs `propose_goal` and `propose_key_result`, the Goal picker on the planning desk's create form and **Attached to** in building settings (both listed as step 1 in the UI inventory), tests `packages/core/test/goals.test.ts`. Kept for now: `set_objective` and `set_key_result` still write (objectives mirror into goals with the same id; a new KR goes under its objective or the building's attachment), since accepting proposals has no UI until steps 3-4; the in-tray's "Mine / All" (step 4) is where routing shows; `Goals.route` computes it now.
2. **The map from the tree.** `treeLayout` (stable, seeded) feeding `computeLayout`; `deriveRoads` routing plaza to parent plaza and door to plaza; `plaza:<goalId>` places with signposts; the trunk rows go; drag placement and drag-resize go from the planning side bar; Desks becomes the size setting; the planning desk's create form gains the Goal picker; the map redraws on every tree change and bodies re-path. Core tests: the same tree gives the same map, adding a sibling moves no earlier building, every door reaches its plaza. **Built** (as_jk5v8pbw7a): `core/world/tree.ts` `treeLayout`; `road.ts` `deriveRoads` (plazas + the tree's edges as org-chart elbows: trunk, bus, drop; doors to their plaza by the old Dijkstra); `plan.ts`, `PUT /api/town/plan` and drag/resize/draw gone; the town map is a read-only zoomed-out view anyone opens, a click selects a building; Desks (PATCH `headcount`, `town.manage_buildings`) sets the size; a World hook rebuilds on every goal event, bodies follow (`followRelayout`); tests `core/test/tree.test.ts`. Open questions decided (Mitchell may overrule): an empty goal is an empty plaza with its signpost; long walks are left as they are (edges are short: 3 rows between levels), no folding.
3. **The Town Hall editor**, with Captain and the Subtree tab, plus the read-only building Goals tab and the attach control in building settings. **Built** (as_4yop6brb1z): the `goal-tree` place (a wall chart, `TILE.GOAL_CHART`, on the Town Hall's back wall above the map table) opens `web/src/panels/GoalTreePanel.tsx` (pure helpers `goalTree.ts`): the open proposals on top (Accept, Edit and accept, Cut with a note to the proposer), the tree (captain pills, building chips, KR status, due date amber when past, funded/open, archived folded to "✓ n done, m missed", Show retired, building filter), and a node's detail (Edit, Add goal, Add key result with a due date, Move, Captain, Retire with the move-to-sibling picker, Met/Missed; History tab from `GET /api/goals/:id/history` = `Goals.history`, Subtree tab). Read-only for everyone without `goals.edit` at the node. The building Overview shows "Reports to <captain> via <goal>"; the Goals tab links to the tree. Left for later: the building Goals tab still has its old editor (set_objective / set_key_result keep working and mirror into the tree; nothing was added to them), the "proposed" grant word in the tree (it shows funded / open), Attach a building from the node (it is in building settings), and Plan with an agent (step 5).
4. **The in-tray and the deck**: goal proposals, "Mine / All", Fund for a node's captain on proposals in their subtree, the per-user review marker, and the state-of-the-town slide without dials. The read-only Spend tab ships here. **Built** (as_ic5rj33cho): the Town Hall in-tray (`GET /api/buildings/:id/intray`) lists open goal proposals (`goalProposals`, a "Goal proposals" section with the editor's Accept / Edit and accept / Cut, `GoalProposalItem`) and counts them in the badge; the review deck gets one `goal-proposal` slide each, in group 4 after the grant proposals. Both responses carry `routes` (item id → goal, captain, `mine`, `canDecide`; core `intray-routes.ts` over `Goals.route`, `Grants.canFund` and `goals.edit`) and `defaultView`: the in-tray's **Mine / All** toggle (a captain who is not an admin starts on Mine, admins on All; Mine is only what routes to the viewer) filters the list and the deck. A node's captain sees Fund / Counter / Reject, Continue / Adjust / Cut and Mark met on grants in their subtree (`GrantRow canDecide`); member funding is unchanged. The **Spend** tab on a goal in the Goal tree (`GET /api/goals/:id/spend?days=7|30|90` = core `goal-spend.ts`): the subtree's adjusted tokens from session rows by lane, by day (≤ 14 days) or week, by building and by key result, and the key results met or missed in the window; it reads sessions only and writes nothing. Left for later: the per-user review marker (`lastReviewedAt` per human, "decided by Lena"), the Finance panel's by-goal view, the grant panel's goal path and "under review" pill. The state-of-the-town slide already has no dials.
5. **Change this goal**: `goal_changes`, under-review KRs, the reorg meeting, and Planner. Planner is needed here as the facilitator, and Plan with an agent ships with it. **Built** (as_61yn0bp2x8): core `packages/core/src/goal-changes.ts` (`world.reorgs`). `POST /api/goals/:id/change` (a human with `goals.edit` there; one open change per goal) writes the human's note at the Town Hall, the `goal_changes` row, one directed prep assignment per attached building (on its building queue, source = the note, its description names the `reorgId`), `underReviewSince` on every open KR under the node (event `kr.under-review`; grants untouched), and a `planning` meeting at the Town Hall scheduled at the 24 h deadline (at once with no building to wait for); the runtime's tick (`Reorgs.tick`) moves it up to now once every prep report is in. The meeting starting sets the goal's text to Y (status `meeting`); its end makes the change `decided` (event `goal.changed` at each stage). `propose_goal` / `propose_key_result` take `reorgId`; the facilitator's material lists the change, the prep reports, its proposals and the under-review KRs. `POST /api/key-results/:id/review` decides an under-review KR: keep, move (`goalId`) or archive (as missed; a live grant is named as a Cut candidate in the event). **Planner** is a Town Hall resident (title "Planner", created on first use); `POST /api/planner/one-on-one` (`goalId` optional) opens "Plan with an agent", a 1:1 whose host session carries the tree brief (`Reorgs.plannerBrief`, scoped to the goal the human last opened it from); it proposes for no building and attaches each `gp_…` to its line, which the meeting panel renders as a proposal card with Accept / Edit and accept / Cut. Web: Goal tree "Plan with an agent" (header, every row, node detail), "Change this goal" with a prep/meeting banner, an "under review" pill and Keep / Move / Archive. **Paid** (as_xl8nklxh62, 1:1 mt_cz11aqe81a): the Town Hall draws from its pool (General unless moved) like any building (`bank.ts` `drawPool` has no Town Hall case), so Planner sessions book to the Town Hall's pool. Only when the Planner can't start (an empty Bank, a used-up share) does its 1:1 say so and the reorg meeting fall back to the first active manager invited as facilitator. Left for later: a deck slide per undecided under-review KR, the in-tray Cut candidates, the under-review flag on new grant proposals, and Planner's first jobs (promotes, dates, the KR inventory).
6. **Postmortems** on missed KRs, and the **Kanban** Queue tabs (building and node). **Built** (as_i7tay9shzl): core `packages/core/src/postmortems.ts` and `kanban.ts`. A human marking a KR missed must give a why-line (`note`; refused without one); `Grants.updateKeyResult` then calls `queuePostmortem`: the line is filed as the human's note (tags `postmortem`, `postmortem-of:kr_…`) in the building whose latest grant named the KR (else the proposing building), and one directed assignment "Postmortem on kr_…" goes on that building's queue with the note as its source. Never two per KR (the tagged note is the guard). Archiving an under-review KR in a reorg goes the same way. When that assignment's final (not parked) report is filed, `linkPostmortem` sets the KR's `postmortemDocId` and tags the report `postmortem`. The goal editor's KR row and the building Goals tab show "postmortem" (a link) or "postmortem pending"; Missed and Archive open a why form. The kanban: `GET /api/buildings/:id/queue` and `GET /api/goals/:id/queue` (one swimlane per building attached in the subtree), Queued / Held (held reason, unmet wait, open offer) / Running (live session adjusted tokens) / Done (24 h, linking the report), Running header "n / headcount desks"; a Queue tab on the building panel and on a goal node. Read-only, no migration, no Bank change. Left for later: the KR proposal at the end of a postmortem is not parsed into the Proposals strip beyond what `propose_key_result` already does.

7. **Streams and the draw order. Bank change, gated on Mitchell.** Inputs become streams (`goalId` scope, key `dailyLimitTokens`); pools go; the Bank pays narrowest stream first, then the general balance; key streams are picked at session start only when they cover the expected session, and the desk gets the cap; held keys show usage and can be revoked; the Donate form warns when a donation covers no whole session, and a stream with no draw for 7 days notifies its donor. Free funds replace the exploration allowance.
   - **Shipped (first part, Pix 1, as_3xd2xv78h1)**: earmarks (`bank_inputs.goalId`, migration 064), the draw order at session start (grant input → nearest earmark covering a session → general), charging the earmark first, `GET /api/bank/streams`, the Donate form's earmark picker and small-donation warning, and the 7-day idle notice to the donor (docs/bank.md "Funding streams and the draw order"). Still to do: pools go, free funds, the desk's key cap, `dailyLimitTokens`, usage shown to a key's donor.
8. **The funder filter on the deck. Bank-gated with step 7** (it reads which stream paid each session): the literal story for key donors, the pro rata story for money donors. **Built** (as_uciill1new, 1:1 mt_cz11aqe81a): read-only, no migration, no Bank booking change. Core `packages/core/src/funders.ts` `funderWeek` reads session rows, Bank inputs and credits: a session that ran on a donated api-key input (`credentialInputId`, general or earmark), or on a grant funded from a member's own input (`fundedWith`), is **literal** for that input's donor, whole; every other session (a subscription, or nothing recorded) is **pooled**, and each subscription donor owns their share of it (their subscription credits in the window ÷ everyone's). `GET /api/funders/:userId/week?days=7` (`me` = the signed-in human; any other id needs a sign-in; guests 401) returns the streams, the literal sessions (assignment, building, KR, report), the pro rata share and what it bought by assignment, the goals the money reached (each earmark's subtree and each literal session's goal; a pro rata share reaches all) and the deck's slide 1 for it (schema `funderSlide`). Web: a signed-in human with a Bank input gets **Funded by me** beside Mine / All in the Town Hall in-tray: the list keeps the items routed under those goals, and the deck replaces the state of the town with "Your week as a funder"; the goal tree's filter gains "Funded by me" (dims what the money didn't reach); a goal's Spend tab gets a "Funded by me" box (`GET /api/goals/:id/spend?funder=me`: literal sessions whole, pooled ones at the share). Tests core `funders.test.ts`, `goals-step4.test.ts`; server `review-deck.test.ts`; web `funderFilter.test.tsx`. This closes the eight-step build order; step 7's rest (pools go, free funds, the desk's key cap, `dailyLimitTokens`, a key's usage shown to its donor) is still open.

The read-only **Spend tab** (subtree spend from session bookings) ships with step 4. Since 1:1 mt_n25udpflus decision 5 (as_n0aqnm802e) the node's four tabs are gone: Spend lives in the Bank's Spending tab as **Spend by goal** (`GoalSpend.tsx`, a goal picker over the same endpoint), Queue only on building panels, History and Subtree nowhere in the web. There is no allocation by node and no budget tree. "New dials" (the second pass's step 7) is dropped while KPIs are parked.

## UI inventory: every web surface the tree touches

From `packages/web/src` at main 5634e04. **Goes** = removed; **changes** = stays, reworked; **new** = doesn't exist yet. The step is the build step that does it.

| Surface (file) | What it does today | Goes / changes / new | Step |
|---|---|---|---|
| Planning side bar (`PlanSideBar.tsx`, reuses `GoalsTab`) | Selected building's goal, objectives, KRs, budget, stats | **Changes**: goal editing goes; shows "Attached to: [goal] · Change…", budget, stats | 2 |
| Town planning mode (`map/townPlan.ts`, `PlanToolbar.tsx`) | Drag to move, drag walls to resize, draw a new building on grass, Save | **Goes**: no drag placement, resize or draw; the map is drawn from the tree | 2 |
| Town Hall town-map table (place `town-map`) | Opens town planning (humans with `town.manage_buildings`) | **Changes**: opens a read-only zoomed-out view of the tree map, or goes; Mitchell's call | 2 |
| Map rendering (`map/MapCanvas.tsx`, `renderer.ts`, `overview.ts`, `Minimap.tsx`) | Draws lots and the trunk roads | **Changes**: draws plazas with signposts and tree roads; no trunk | 2 |
| Planning desk Buildings tab (`PlanningPanel.tsx`) | Create a building (name, goal line) | **Changes**: gains a required **Goal** picker (default: the root) | 1 |
| Building settings (`BuildingPanel.tsx` Settings) | Goal line, Desks (read-only, "resize on the town map table"), Exploration / day, Pool | **Changes**: new **Attached to** control (never empty); Desks becomes editable and sets the size; Exploration / day and Pool moved to the goal's Funding block (interim step, "Pool and exploration budget on the goal") | 1, 2, 7 |
| Building panel Overview (`BuildingPanel.tsx`) | "Write them in Goals →" | **Changes**: "Reports to: <owner> via <goal>", link to the goal at the Town Hall | 3 |
| Building Goals tab (`GoalsTab.tsx`, `keyResults.ts`) | Write and edit objectives and KRs, Mark met/missed, Delete | **Changes**: read-only subtree view, "Edit at the Town Hall →", Propose a key result | 3 |
| Goal tree editor (Town Hall wall chart) | — | **New**: tree, node detail (its History, Subtree, Spend and Queue tabs were dropped in mt_n25udpflus decision 5), Proposals strip, Plan with an agent | 3, 5, 6 |
| Town Hall in-tray (`Places.tsx`) | Rollups, grant proposals and checkpoints, KR mark met/missed on a closed grant | **Changes**: goal proposals, "Mine / All", under-review pills, retire/reorg items | 4, 5 |
| Review deck (`ReviewDeck.tsx`, `DeckView.tsx`) | State of the town, one slide per pending decision | **Changes**: goal-proposal and reorg slides; no dial slides; the funder filter ("Funded by me": the funder's slide 1 and their items) | 4, 5, 8 |
| Grant panel and grant cards (`GrantPanel.tsx`, in-tray `GrantRow`) | Shows the grant's key result | **Changes**: shows the KR's goal path from the root; "under review" pill | 4 |
| Dashboard (`DashboardPanel.tsx`) | Three KPI tiles, then each building's objectives and KR statuses | **Removed** 2026-11-01 (1:1 mt_ec2b7x80rg): panel, HUD ▤, KPI tiles and `GET /api/kpis` | 3 |
| Bank panel (`BankPanel.tsx`, `BankFunding.tsx`) | Donate, allocations, inputs, accounting pools | **Changes**: pools and allocations go; inputs become streams with an optional goal scope; held keys show usage and Revoke; Donate warns "your key covers no whole session yet" | 7 |
| Bank town map (`map/flow.ts`, place `bank-map`) | Lots tinted by pool, coin arcs sized by pool share | **Changes**: pools go, so it needs a new meaning (streams by scope) or it goes | 7 |
| Finance panel (`FinancePanel.tsx`) | Totals, Sources, Pools, Spending by building | **Changes**: Pools section goes; Spending gains a by-goal view (**built**: Spend by goal, mt_n25udpflus decision 5) | 4, 7 |
| Meeting panel (`MeetingPanel.tsx`) | 1:1s and building meetings | **Changes**: reorg meetings (kind `planning`), Plan with an agent proposal cards; cadence meetings go | 5 |
| Building Queue tab | — | **New**: kanban view (the goal Queue tab was built, then dropped in mt_n25udpflus decision 5) | 6 |

Not touched: the Agent panel, the Library, Outbox, Manual and How it works (no objective or pool text found), Secrets, Skills, Connect your agent.

## Open questions for Mitchell

Answered in 1:1 mt_kh0zaqui0w (2026-10-30), folded into the doc above:

- ~~**Dial-target KRs: auto-claim?**~~ *Parked: no KPIs yet. He said a crossing would set `claimed` and he'd still mark met, but there are no dial-target KRs and no dials in the tree until he wants KPIs back.*
- ~~**Retiring a goal with open KRs.**~~ *Retire offers move-to-sibling; refused when no sibling is picked.*
- ~~**Must every goal sit under Fund / Join / Trust?**~~ *One root (the town goal); Fund/Join/Trust are placeholder children; any other child is allowed; the tree will be iterated; depth unbounded; KRs are always dated leaves.*
- ~~**New buildings unattached?**~~ *Never: attached at creation (default: the root), editable in building settings, never unset.*
- ~~**Planner: who pays?**~~ and ~~**Budget by node**~~ *answered by mt_529jbnwvmi decision 1.*
- ~~**What captains can do.**~~ *A captain decides and funds grants in their subtree (funding is no longer admins-only; member funding via kr_6f9c200vsx unchanged). Captains are humans only for now; managers propose.*
- ~~**Reorg meeting date.**~~ *The meeting opens when every attached building's prep report is in, or 24 h after the change is filed, whichever comes first; grants keep running meanwhile.*
- ~~**Skip-level with forks.**~~ *Dropped for now: Mitchell 1:1s managers directly. Noted as a possible later addition.*
- ~~**A key below one session's cost.**~~ *Confirmed: one key per session; such a key never runs a session alone and accrues. Added: a donation-time warning and a 7-day unused-donation alert (in-town; outside alerts via the pinger).*

Decided while building step 2 (as_jk5v8pbw7a), Mitchell may overrule:

1. **An empty goal node** is drawn: an empty plaza (4 tiles wide) with its signpost, so the gap is visible.
2. **Long walks on deep trees**: left as they are. Levels sit 3 rows apart and roads run straight, so a level costs about its building's height plus 5 tiles of walk; no folding of single-child chains until a real tree makes walks hurt.
