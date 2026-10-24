# The waterfall — goal-directed budgets reconciled with "Mitchell talks to managers only"

Status: **design note, waiting for Mitchell's go on the build order** (town hall decision 4 of 2026-10-24, notes `dc_guoh97iq91`). Author: Pix. Town copy: dc_g9d74v8kdb. Written from main at 8d2f07d (live). It reconciles `docs/goal-directed-budgets.md` (dc_k955hun6c4) with what Mitchell said at the town hall: he talks to managers only; agent reports stay, but managers review them and roll them up into a Town Hall in-tray; he drills down into a building only when he wants to; the manager's 1:1 is the channel.

## 1. What Mitchell said (his words, condensed)

"I don't want to talk to or read reports directly from opus agents (unless I really want to drill down for some reason)." "A waterfall, where I talk to you guys and you delegate to the other agents in your building." "Reports stay but managers roll them up." "Town hall meetings and rollup reports into a townhall intray is probably the right interface right now, with drill downs into buildings being legible in a similar recursive manner, if I need to." He asked for the goals/KPIs/proposals design to be found and carried forward.

## 2. What is true today (verified in code and on the live town)

- **Reports already stop at the manager.** `submit_report` files the report in the building's in-tray (`intrayOf`, pending reports of that building) and the resident goes idle. Nothing pushes a report to Mitchell except that he holds every role: the in-tray is a place in each building, and the review policy `human` means a human works it. Review is one text box and one button (`reply.ts`): a reply becomes the author's next assignment, an empty reply archives.
- **A reviewer agent can already work an in-tray.** Review policy `reviewer` makes the runtime run a short tool-limited review session per pending report (`maybeReview` in `runtime/src/work.ts`, prompt `reviewSystemPrompt`). The Workshop has Keel seeded as reviewer but runs policy `human`. The manager role already holds `building.review`.
- **The manager is the only conversational surface** (design review 5, 3c5914c): `messageAgent` refuses residents of a building with a manager; the proxy chat refuses residents outright. But a message to the manager still becomes a `Message from …` assignment that runs a desk session and ends in a report. There is no 1:1.
- **Goal-directed budgets are one third built.** Steps 1a–c shipped on 2026-10-21 (7bef911, 2eae49f, 441a7f3): `grants` and `key_results` tables (migration 025), the `Grants` service (`world.grantDesk`: draft, propose, fund/counter/reject, checkpoint continue/adjust/cut, close, key-result status, derived spend, exploration allowance), REST routes under `/api/grants`, and the board route returning the grant board. Not built: lanes and the `canStart` gate (step 2), the board UI and funding buttons (step 3), the key-results prompt block (step 4), the pilot (step 5). Every building is still `budgetMode: open`.
- **The Town Hall has no in-tray and no manager agent.** Its furniture is mod station, bench, planning desk, schedule board, library, trophy cases, outbox, meeting table. Town-hall meetings invite every building's manager and reviewer agents plus the moderators (`defaultAttendees`); their notes go to the library and their decisions become assignments.
- **Meetings** have four kinds (standup, retro, planning, town-hall), a scheduler that starts `scheduled` ones, one-shot summaries and a tool-using facilitator. Kelly is researching how they work in practice (town hall decision 3); her report is an input to step 5 below.

## 3. The reconciliation

The budgets design put the human's surface on the **building board** (proposal cards, fund buttons, checkpoint buttons, an amber dot on the map). The waterfall moves the human's surface to the **Town Hall in-tray** and the **manager's 1:1**. The board stays, but as the residents' surface: the goal and key results they work toward. Everything else in the budgets design survives unchanged: the building goal, grants with 2–3 human-observable key results, proposals that Mitchell funds, counters or rejects, the 50% checkpoint, the three spend lanes and the gate, the exploration allowance, and `building.fund` as a human-only permission.

Three tiers, the same shape at each level:

| tier | who talks | what lands in the in-tray | who decides |
|---|---|---|---|
| Town Hall | Mitchell ↔ managers (1:1, town-hall meetings) | manager **rollups**, grant **proposals**, **checkpoints**, **escalations** | Mitchell: one text box, one button; Fund / Counter / Reject; Continue / Adjust / Cut |
| Building | manager ↔ residents (assignments, standups) | resident **reports** | the manager agent, in a review session; escalates by rollup |
| Resident | nobody; works from assignments | — | — |

Drill-down is free if every rollup lists the reports it covers in its provenance (`sourceIds`): Town Hall in-tray → rollup → covered reports (DocView already renders sources) → report → session transcript. The building in-tray and filing cabinet are already readable by anyone, so "drill into a building" is walking to it, as now.

### 3.1 The autonomy rule (town hall decision 5) as code

- New review policy **`manager`**: the building's manager agent works the in-tray. The runtime runs a review session for each pending report (today's `maybeReview`, generalised: the reviewer is `building.managerAgentId`, the system prompt is the manager's with its team block and memory). The manager approves, replies (which assigns), or stops. Undecided reports stay in the in-tray.
- **Escalation criteria**, in the manager's review prompt: decide yourself unless the decision (a) changes the building goal or a key result, (b) spends money outside a funded grant or the exploration allowance, (c) needs a human in the real world (`request_human`), or (d) the report's author asks for something only a human can give (merge rights, a secret, a credential). Those go into the next rollup's "Needs from Mitchell", not to Mitchell directly.
- `AGENTS.md` non-negotiable 1 ("nothing continues without a decision") stays true one level down: nothing continues without the **manager's** decision, and the manager's work continues only through rollups, grants and checkpoints that Mitchell decides.

### 3.2 Rollups

- **What:** a `report` doc by the manager, tagged `rollup`, filed in its building like any report, listed in the Town Hall in-tray while pending. Its provenance `sourceIds` are the reports it covers. Body, four short sections: *Shipped* (what is live, with commits or doc ids), *Decided* (each covered report → what the manager replied), *Key results* (status of each funded grant's KRs with the spend bar numbers), *Needs from Mitchell* (at most two items; "Nothing needed" is valid). Readable in a minute, like a report.
- **When:** at the end of a manager review session, when either a covered report hit an escalation criterion, or at least 24 h passed since the last rollup and something was decided. No rollup when nothing happened, so an idle building is silent. A town-hall meeting also produces one per manager (the standup summary becomes the rollup's draft).
- **Decision on a rollup:** the same reply box. A reply becomes the manager's next assignment; the manager, not Mitchell, turns it into resident work. An empty reply archives.
- **Reports Mitchell never sees by default:** the Town Hall in-tray shows only rollups, proposals, checkpoints and escalations. The building in-tray keeps showing resident reports to whoever walks there.

### 3.3 Proposals and checkpoints

Unchanged in substance from the budgets design, moved in place: a `proposed` or `countered` grant and a grant at `checkpoint` are Town Hall in-tray rows with the same buttons the budgets design put on the board (Fund with a token field prefilled to the ask, Counter with a note, Reject; Continue, Adjust, Cut). `POST /api/grants/:id/decide` already exists. The manager proposes from a 1:1 or at the end of a review session ("if exploration findings are in and no proposal is open, draft one", as the budgets design says). The board keeps the read-only view for residents.

### 3.4 The manager's 1:1 (the channel)

- **What it is:** a conversation between one human and one manager agent with no assignment and no report. Mitchell can set or change the building goal there, ask what is going on, and hand the manager work, which the manager turns into assignments on the spot.
- **How:** reuse the meeting machinery. A meeting of a new kind `one-on-one`, building-scoped, attendees = [the manager], created in phase `discussing` (no summaries), the human as the only other speaker. The manager side is a host `runAgentSession` with town verbs and the manager's prompt blocks (memory, team), fed the human's utterances through the existing streaming input and interrupt path (Root's note dc_e8tgzb2t3b, section 1). Each turn the manager speaks through the `meeting` verb and may `assign`. Decisions recorded in the 1:1 become assignments through `meetingDecide`, as in any meeting. The human ends it (the typing guard already prevents an agent closing under a typing human); the notes doc is the transcript, filed in the building's cabinet. The 1:1 session spends the manager's budget; it runs on the host, so it can't edit code, which is right for a manager.
- **UI:** "Talk to ★ <manager>" on the agent and building panels opens the 1:1 (the meeting panel with the composer) instead of the message composer. A building without a manager agent keeps today's direct message. The `Message from …` assignment path stays for messages to visitors and to manager-less buildings.
- This is the thing my last report asked about (dc_ugr1hymvm5). Sage's original 1:1 (a resident chat) is dropped; this one is the manager's.

### 3.5 The Town Hall in-tray

A new place in the Town Hall (`intray:town-hall`, furniture piece next to the planning desk) with the existing `IntrayPanel`, fed by `GET /api/buildings/town-hall/intray`, whose query for the Town Hall becomes: pending rollups across all buildings, plus grants in `proposed`, `countered` or `checkpoint`. Rows carry the building's name and sprite, expand to the covered reports, and offer the decision controls for their kind. The HUD shows its count the way building panels show theirs. Nothing else in the Town Hall changes.

## 4. What this drops or changes from dc_k955hun6c4

- Board proposal cards with Fund/Counter/Reject and the amber map dot: dropped. Humans decide in the Town Hall in-tray.
- Checkpoint reports "mention humans in their inbox": replaced by the checkpoint row in the Town Hall in-tray (a mention still goes out, as `Grants.propose` does today).
- "The manager gets an assignment to write the checkpoint report": kept, but the checkpoint report is a rollup (tagged `rollup`, with the grant linked), so it lands in the Town Hall in-tray like everything else Mitchell reads.
- The four open questions (exploration size, directed work, who funds, reservations): still open, carried forward unchanged. The defaults in code are 10% per building, directed bypasses grants, `building.fund` for human managers and admins, ceilings.

## 5. Build order with owners

Each step is small, lands on main behind a flag or a policy value, and is usable alone. Owners are Workshop residents; Kelly's meetings report (town hall decision 3) feeds step 5.

| # | step | owner | depends on |
|---|---|---|---|
| 1 | **Core: review policy `manager`, rollups, Town Hall in-tray query.** `reviewPolicy` gains `manager`; `submit_report` gains `rollup: true` (managers only; tags the doc, requires `sourceIds`); `intrayOf(town-hall)` returns pending rollups plus open proposals and checkpoints; manager review prompt with the escalation criteria and the rollup rule; tests; `v12.test.ts` line for any new migration. | Pix | — |
| 2 | **Runtime: manager review sessions and the rollup trigger.** Generalise `maybeReview` to policy `manager` (reviewer = `managerAgentId`, manager prompt blocks); track the last rollup per building; tell the review session when a rollup is due; the 24 h / escalation rule. | Root | 1 |
| 3 | **Web: Town Hall in-tray.** The `intray:town-hall` place and furniture; `IntrayPanel` rows for rollups (expand to covered reports), proposals (Fund / Counter / Reject) and checkpoints (Continue / Adjust / Cut); HUD count; building in-tray badge "worked by <manager>". Mock server fixtures. | Lena | 1 |
| 4 | **The manager's 1:1.** Meeting kind `one-on-one`; host session for the manager with streaming input; "Talk to ★" opens it; end → notes doc, decisions → assignments. Root's `delegate` verb (dc_e8tgzb2t3b §4) is not needed for this: the manager already has `assign`. | Root | — (can start now) |
| 5 | **Budgets steps 2 and 4** from dc_k955hun6c4: lanes on assignments and sessions, the `canStart` gate, the 50% / 100% checkpoint that creates the manager's checkpoint-rollup assignment; the key-results block in the brief. | Pix | 1, 2 |
| 6 | **Budgets step 3, board as the residents' key-results view** (goal, funded KRs with status, exploration meter; no funding buttons). | Lena | 3, 5 |
| 7 | **Pilot: Town Workshop** flips to `reviewPolicy: manager` and `budgetMode: goal-directed`; first rollup; first proposal funded from the Town Hall in-tray; Mitchell's first 1:1 with Pix. Reword `AGENTS.md` non-negotiable 1 per §3.1. | Pix | 1–6 |

Steps 1 and 4 can start at once and in parallel. Steps 1–4 are roughly one desk session each at the Workshop's median (about 1 M tokens per session, range 0.2–10 M, from the 38 reports counted on 2026-10-21); steps 5–6 are one to two each. Sage stays stopped unless Mitchell wants a fourth pair of hands; nothing here needs Sage specifically.

## 6. Decisions needed from Mitchell

1. Go on the build order above, or say what to drop. The three choices worth a look: rollups as tagged reports in a Town Hall in-tray (§3.2, §3.5); review policy `manager` as the Workshop default (§3.1); the 1:1 built on the meeting machinery (§3.4).
2. The four open questions of dc_k955hun6c4 can wait until step 5.
