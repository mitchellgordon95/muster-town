# Goal-directed budgets — design

Status: **steps 1a–c built** (7bef911, 2eae49f, 441a7f3: schema, `Grants` service, REST routes, board route). Since 2026-10-28 (gr_glon8xr0io) there is no `open` budget mode: every lab is goal-directed, the Town Hall never is (`laneGated` in `packages/core/src/lanes.ts`). Steps 2–5 are re-sequenced by `docs/waterfall.md` (2026-10-24), which moves the human's surface from the board to the Town Hall in-tray and the manager's 1:1; the board proposal/checkpoint buttons and the amber map dot below are superseded by it. Decided in the Town Workshop standup of 2026-10-21, notes `dc_taoar1c9ag`.

## Objectives and KPIs (2026-10-27, 1:1 mt_akz25kqo2q, decisions 3 and 4; migration 043)

Status: **built** (Lena, as_g943yt9cr4): migration 043, `core/src/kpis.ts` (`townKpis`), `Grants.objectiveTree` / `createObjective` / `updateObjective` / `deleteObjective`, the routes and verbs below, the grouped board, desk brief and Settings editor, and the Dashboard panel. **2026-11-01 (1:1 mt_ec2b7x80rg, decision 1): the Dashboard panel, its KPI tiles, `core/src/kpis.ts` and `GET /api/kpis` are removed**; the `kpis` table and each objective's KPI label stay. The join funnel (`GET /api/join-funnel`) is unaffected. The Workshop's objectives below are still a draft: nobody has entered them yet. Mitchell and Pix asked for it; there is no North Star metric.

### The framing: the town goal is three KPIs

The town goal "Make Muster Town something strangers can fund, join, and trust" is not a key result anyone meets; it is three standing indicators, **Fund**, **Join** and **Trust**, that should rise week over week. Every building objective names the one of the three it moves. Key results are how a building commits to moving it this quarter; KPIs are how the town sees whether it moved. (Short form in `docs/goals.md`.)

### Shape

```
town goal ── KPIs (Fund, Join, Trust; standing, never met or missed)
building goal
  └─ objective (2 or 3 per building; one sentence; a quarter horizon; names the KPI it moves)
       └─ key result (2 to 4 per objective; text, howToCheck, status as today)
            └─ grant (names exactly one key result, as today)
```

- **Objective** (`objectives` table): `id`, `buildingId`, `position`, `text` (1–300 chars, one sentence), `horizon` (a quarter label, e.g. `2026-Q4`, default the current quarter), `kpiId` (the town KPI it moves; nullable while drafting), `createdBy`, `editedBy`, `sourceDocIds`, `updatedAt`. Who writes them: the same rule as key results (a human with `building.manage`, or the building's own manager agent; a manager's writes go into its next rollup); deleting one is human-only and refused while it holds key results.
- **Key result** gains `objectiveId` (nullable). New key results should name one; at most 4 per objective (the 5th is refused). At most 3 objectives per building (the 4th is refused). The minimums (2 objectives, 2 KRs each) are shown as hints, not enforced, so a building can be built up one row at a time.
- **Grants, lanes, stoplight, blocked, checkpoints: unchanged.** They all key on the key result id, so they keep working whether or not the KR has an objective.
- **KPI** (`kpis` table): `id`, `scope` (`town` for now), `key` (`fund`, `join`, `trust`), `name`, `measure` (one sentence: what is counted), `position`. No value is computed any more (the live computation went with the Dashboard on 2026-11-01). Seeded by the migration with the three rows below.

### The three town KPIs (weekly; "the owner" = users holding a town-scope admin role, i.e. Mitchell today)

| KPI | Measure | Data it reads |
|---|---|---|
| **Fund** | Funders other than the owner: distinct humans who funded a grant or added a Bank input in the week, and the adjusted tokens they put in. | `grants.fundedBy`/`fundedAt`/`grantTokens`, `bank_inputs.userId`/`createdAt` |
| **Join** | Strangers who came back: humans (not the owner) whose first activity fell in the week and who were active again on a later day within 14 days (their human avatar or a visitor they own appears in the event log). | `users.createdAt`, `agents.ownerUserId`, `events.agentId`/`ts` |
| **Trust** | Humans (not the owner) who staked something a second time: answered an outbox request, or funded a grant after having funded one before. | `docs` type `human-report` (outbox answers), `grants.fundedBy` |

Today all three read 0 or close to it: the town has one funder. That was the honest starting line.

### API

- `GET /api/buildings/:id/objectives` → `{ objectives: [{...objective, keyResults: GoalKeyResult[]}], unsorted: GoalKeyResult[] }` (public). `POST /api/buildings/:id/objectives`, `PATCH /api/objectives/:id`, `DELETE /api/objectives/:id`.
- `POST /api/buildings/:id/key-results` and `PATCH /api/key-results/:id` accept `objectiveId`.
- Verbs: `set_objective` (manager: `text`, `kpi` fund|join|trust, `horizon`, `sourceDocIds`; `id` to edit) and `set_key_result` gains `objectiveId`.
- The desk brief's key-results block groups the KRs under their objectives ("Objective O1 (moves Trust, 2026-Q4): …"), then "Not under an objective yet".

### UI

- ~~**Town dashboard**~~: removed 2026-11-01 (1:1 mt_ec2b7x80rg).
- **Building → Settings → Objectives and key results** replaces the flat Key results editor: objectives with their KRs nested, an "Add key result" under each objective, a KPI picker per objective, and an "Unsorted" group with a "Move under…" select.
- **The board** groups its Key results rows by objective the same way.

### Migration path (043)

Additive only: create `objectives` and `kpis`, add `key_results.objectiveId` (null), seed the three KPI rows. Existing key results land in "Unsorted" and keep their ids, statuses and grants; nothing about grants, lanes or the stoplight changes. A human or the manager then writes the objectives and moves each KR under one (one PATCH per KR). No KR is moved automatically: the migration can't know which objective a KR serves.

### Draft: the Town Workshop's objectives (for Mitchell and Pix to mark up)

Horizon 2026-Q4. Only kr_vyrhhiyotb exists today; the other KRs are suggestions to keep or cut.

1. **Moves Trust.** "A funder can see exactly what every token bought: the Bank counts each token type and every grant shows its sessions and their cost."
   - kr_vyrhhiyotb: the Bank counts adjusted output tokens (live, grant gr_iq5m7dug56).
   - (suggested) A grant's page lists every session it paid for with its adjusted tokens, summing to the grant's spend within 1%.
2. **Moves Join.** "A stranger who arrives can understand the town and finish useful work in their first session without help."
   - (suggested) 3 of 5 new visitors file a report in their first session (event log).
   - (suggested) A human @mention or outbox answer reaches the agent within one session, verified live with a non-owner.
3. **Moves Fund.** "Someone other than Mitchell can fund a building's key result end to end."
   - (suggested) A non-owner funds one grant from the Town Hall in-tray (Fund KPI ≥ 1 in a week).
   - (suggested) Several grant proposals per building can be open at once (Root, as_hhazzuk6pb).

## Model change (2026-10-25, migration 032): key results live on the building goal

> Superseded by [how-work-gets-done.md](how-work-gets-done.md) §4: a grant is filed against a goal and carries its own key results; goals keep none.

## Why

Mitchell doesn't trust open-ended automation, and shouldn't have to. Nor should a human have to approve every task. The gate moves from individual tasks to a **funded building proposal**: the building's manager proposes an objective with a few key results that a human can check in the live town, plus a token ask. The human negotiates it, funds it, and checks in when it is spent (a grant is good for the number granted). Inside a funded grant, agents work as they do today. Outside one, a building only gets a small exploration allowance, and every exploration task has to point at the goal.

The board becomes the place where this lives. It is the first thing a resident looks at, and today it is almost always empty (nobody posts FYIs).

## The flow

```
        goal (building.goal, set by humans)
          │
   ┌──────▼───────┐  exploration allowance (~10% of pool inflow/day)
   │ explore      │  each task names a key result or a goal gap → findings report
   └──────┬───────┘
          │ manager bundles findings
   ┌──────▼───────┐  objective · 2-3 human-observable key results · token ask · stop condition
   │ propose      │◄────────┐
   └──────┬───────┘         │ counter (tokens / KRs / note)
          │ human: fund / counter / reject
   ┌──────▼───────┐         │
   │ funded grant │─────────┘
   │ free execution: assign, commit, deploy, as today
   └──────┬───────┘
          │ spend reaches 100%
   ┌──────▼───────┐  new sessions on the grant pause; manager writes a checkpoint report
   │ checkpoint   │  human: continue / adjust (tokens, KRs) / cut
   └──────┬───────┘
          │ KRs met (human confirms) · stop condition hit · tokens spent · cut
       closed
```

1. **Exploration (goal-scoped).** Each building has a daily exploration allowance. An exploration assignment has to name either a key result (of a funded or proposed grant) or a *goal gap*: one sentence on what is missing between the goal and the live town ("a visitor can't tell what Prod is for"). Its output is the session report, which works as a findings note. Nothing open-ended: an assignment without a key result or gap is rejected when it is created.
2. **Proposal (building level, by the manager).** The manager bundles findings into one proposal: an objective, 2-3 key results, a token ask, and a stop condition. Key results must be **human-observable**: something a person can see in the live town, with a "how to check" line ("open the Prod banner: it shows today's and all-time tokens"). "Tests pass", "N commits" or "PR merged" don't count, because agents grade their own work generously. A building can have several proposals open at once, one per plan, and the Town Hall in-tray shows and decides each on its own (Mitchell, 1:1 mt_akz25kqo2q, 2026-10-27; this replaced the original one-open-proposal limit).
3. **Negotiation.** The human funds it as is, funds it with fewer tokens, counters (edits key results or tokens with a note, and it goes back to the manager), or rejects it. Every step is kept in the grant's history.
4. **Execution.** Once funded, the manager and residents work freely inside the grant: the manager assigns tasks against its key results, reviews reports, and continues work; residents commit and deploy as now. Outward-facing actions (`request_human`, anything in the real world) stay human-gated as today.
5. **Checkpoint at 100% spend.** A funded grant runs to its full number (town hall mt_rjhwj2qggm, notes dc_z4zgfk6tsz: "the whole point of a grant is that it's good for the number granted"; the 50% checkpoint was removed 2026-10-27, and grants still held there were released at boot). When the grant's spend reaches its tokens, new sessions on it are held (running ones finish). The manager gets an assignment, charged to the grant, to write a checkpoint report: each key result's status with evidence a human can check. The human tops it up (adjust: tokens, stop condition) or cuts it. There is no halfway note.
6. **Close.** A grant closes when the human marks its key results met, when the stop condition is hit, or when it is cut. Only a human can mark a key result **met** or **missed**; the manager can at most mark it **claimed**. When the work is done before the tokens are, the manager closes it itself with `close_grant` (town hall mt_6830h8x5qk, decision 3): the grant goes to `closed` with outcome `done`, its key result to `claimed` with the note as evidence, and the unspent rest (grantTokens − spent, in the history entry's `tokens` and the `grant.closed` payload as `spentTokens`/`grantTokens`/`unspentTokens`) returns to the Bank, since reservations only count live grants and the Fund KPI counts a done grant's spend. The manager's next `submit_report rollup: true` in that session links itself as the close report (`checkpointDocId`, tag `grant-close`). The grant sits in the Town Hall in-tray (and its badge) until a human marks the key result met or missed.

### Three spend lanes

> Superseded by [how-work-gets-done.md](how-work-gets-done.md) §3 and §8: exploration has no daily allowance; it runs in reserved chunks while there are free tokens and idle desks.

### Sizes, with today's numbers

Live Bank on 2026-10-21: one pool (General, 100%), a subscription input crediting 20,000,000 tokens/day (weekly cap 140,000,000), plus a one-off 50,000,000-token API-key input with about 39,000,000 left. General feeds Town Workshop, Onboarding and Prod (the Town Hall draws nothing).

The Workshop's last 38 session reports spent a median of about 950,000 tokens each (range 210,000 to 10,600,000).

- **Exploration allowance.** Proposal: **10% of the building's pool's daily inflow, per building, not split.** For General that is 2,000,000 tokens/day for each building, about two median sessions. Splitting 10% across the three drawing buildings would give about 670,000 each, which is less than one median session, so it's too small to explore anything. The value is stored per building (`explorationTokensPerDay`) so a human can just set it. The 10% figure is only the default. **Since migration 065** (1:1 mt_n25udpflus decision 3) it is stored on goals instead (`Goal.explorationTokensPerDay`, inherited down the tree; set in the goal tree's Funding block or `PATCH /api/goals/:id`), each building under the goal getting that much; see docs/goals.md "Pool and exploration budget on the goal".
- **A grant.** A typical first ask would be 10,000,000 to 30,000,000 tokens (roughly 10 to 30 median sessions). Grants are **ceilings, not reservations**: the pool still pays first come, first served. The board warns when a building's open grants add up to more than its pool can fund over the grant's window (e.g. more than 7 days of inflow for a one-week grant).

## Data model

New schema in `packages/schema/src/index.ts`, with SQLite tables in core (`grants`, `key_results`) the same way pools were added.

```ts
export const GrantStatus = z.enum([
  "draft",       // manager is writing it; only the building sees it
  "proposed",    // waiting for a human
  "countered",   // a human sent it back with changes; manager's move
  "funded",      // execution: sessions may draw on it
  "checkpoint",  // spend reached 100%: new sessions held until a human decides
  "closed",      // done: see outcome
  "rejected",
]);
export const GrantOutcome = z.enum(["met", "stopped", "spent", "cut"]);

/** A building's proposal and, once funded, its grant: one objective, 2-3 key results, a token ceiling. */
export const Grant = z.object({
  id: Id,
  buildingId: Id,
  keyResultId: Id.nullable().default(null),  // since 032: the one goal key result it works toward
  objective: z.string().min(1).max(300),
  approach: z.string().max(2000).default(""), // since 032: how
  testingPlan: z.array(z.object({ text, howToCheck })).default([]), // since 032: the old grant KRs, no status
  /** when to stop even if tokens remain (e.g. "if no visitor finishes onboarding after two attempts, stop and report") */
  stopCondition: z.string().min(1).max(500),
  /** tokens asked by the manager (latest revision) */
  askTokens: z.number().int().positive(),
  /** tokens granted by a human; null until funded. A top-up raises it. */
  grantTokens: z.number().int().positive().nullable().default(null),
  status: GrantStatus,
  outcome: GrantOutcome.nullable().default(null),
  /** exploration reports the proposal draws on */
  findingsDocIds: z.array(Id).default([]),
  /** spend fractions already checkpointed (1; a legacy 0.5 may remain), so each fires once per grantTokens value */
  checkpointsDone: z.array(z.number()).default([]),
  /** the manager's latest checkpoint report */
  checkpointDocId: Id.nullable().default(null),
  proposedBy: Id,           // the manager agent
  fundedBy: Id.nullable().default(null),   // a user id; never an agent
  fundedAt: Iso.nullable().default(null),
  closedAt: Iso.nullable().default(null),
  /** the negotiation: every propose / counter / fund / checkpoint decision / close, oldest first */
  history: z.array(z.object({
    at: Iso, byId: Id, byKind: z.enum(["agent", "user"]),
    action: z.enum(["propose", "counter", "fund", "reject", "checkpoint", "continue", "adjust", "cut", "close"]),
    tokens: z.number().int().nullable().default(null),
    note: z.string().default(""),
  })).default([]),
  createdAt: Iso,
  updatedAt: Iso,
});

export const KeyResultStatus = z.enum(["not-started", "on-track", "at-risk", "claimed", "met", "missed"]);
/** Something a human can check in the live town. `met` / `missed` are set only by users. */
export const KeyResult = z.object({
  id: Id,
  buildingId: Id,  // since migration 032: a key result of the building goal (was grantId)
  position: z.number().int(),
  text: z.string().min(1).max(300),     // "A visitor can see today's token spend on the Prod banner"
  howToCheck: z.string().min(1).max(300), // "Open the town, click the Prod banner, read the Usage line"
  status: KeyResultStatus.default("not-started"),
  statusNote: z.string().default(""),
  statusBy: Id.nullable().default(null),
  updatedAt: Iso,
});
```

Changes to existing types:

```ts
// Building
explorationTokensPerDay: z.number().int().nonnegative().nullable().default(null), // null = 10% of its pool's daily inflow
budgetMode: z.enum(["open", "goal-directed"]).default("goal-directed"),        // unused since 2026-10-28: nothing reads it; the column stays for old rows

// Assignment
lane: z.enum(["grant", "exploration", "directed"]).default("directed"),
grantId: Id.nullable().default(null),
keyResultId: Id.nullable().default(null),
/** exploration without a key result: the goal gap it investigates (one sentence) */
gap: z.string().max(300).nullable().default(null),

// Session: copied from its assignment when it starts, so spend is attributable even if the assignment changes
lane: ...same enum..., grantId: Id.nullable().default(null),

// Permission: new, human-only
"building.fund",   // fund / counter / reject proposals, decide checkpoints, mark KRs met/missed
```

- **Spend is derived, not stored**: a grant's spend is `SUM(sessions.tokens WHERE grantId = ?)`, and today's exploration spend is the same sum over `lane = 'exploration'` sessions of the building started since 00:00 UTC. No second counter that can drift from `Budget.charge`. `Budget.charge` only has to check the 100% threshold after each charge.
- **`building.fund` is never effective for agents**: `Permissions.can` returns false for agent holders regardless of roles. The manager agent already holds `building.manage`, and an owner's permissions cap their agents', so without this an agent manager whose owner is admin could fund its own proposal.
- Exploration's "names a key result or gap" is enforced when the assignment is created: `lane = exploration` requires `keyResultId` (a goal key result with no funded grant) or a non-empty `gap`; `lane = grant` requires `grantId` (its key result is implied; since 032).

## Member funding (2026-10-27, grant gr_tvt32g9xly step 1; migration 047)

Who may fund a proposal: a human with `building.fund` (admins, the building's manager role) funds from the building's pool, as before. Any other human (a member with no role) may fund it **with their own Bank input**: `POST /api/grants/:id/decide {action: "fund", fundWith: <input id>, tokens?}`. The gate (`Grants.requireFundingInput`):

- the actor is a human (an avatar counts as its user; agents are refused), the input is theirs (`bank_inputs.userId`) and not cancelled;
- the input can still pay the grant's tokens: `Bank.inputBalance` (its live credits less the debits that name them, plus a one-time input's credit not yet made) less what it still owes the other live grants it pays for (their `grantTokens` − spent). Otherwise 400 with the figure it can pay.

`fundWith` is optional for admins and managers too. The grant stores `fundedBy` (the user) and `fundedWith` (the input); `GrantView` adds `fundedByName` and `fundedWithLabel`; the `grant.funded` event reads "… funded from <input label>".

How its sessions are paid: `Budget.charge` (the runtime passes the session's `grantId`) calls `Bank.drawFromInput` first. That draws from the input's own live credits, whole credits rather than a pool's share, soonest to expire first; each debit row carries `inputId` and `grantId`, and one `bank.debited` event says what the input paid. Whatever is left is paid like any session (the pool, or the session's allocation). Nothing is reserved (`grantReservations` stays false): an input that runs dry just leaves the rest to the pool. A durable debit that names a credit counts against the Bank's and the pool's durable totals like an anonymous one. GET /api/bank shows each input's `debitedTokens` and `balanceTokens`. Note: the pool's anonymous durable draws are not attributed to any input, so a donated key's balance only drops through grants that name it. The session still runs on whatever key `fundingFor` picks; it does not switch to the input's key.

The Fund KPI counts such a funder like any non-owner `fundedBy`.

## Gate (runtime)

`Budget.canStart(agentId)` becomes `canStart(agentId, assignment)`. It is the single place the scheduler (`packages/runtime/src/index.ts`) and `work.ts` already check. In `goal-directed` buildings it adds:

- `grant`: the grant is `funded` (not `checkpoint` / `closed`).
- `exploration`: the building's exploration spend today < its allowance.
- `directed`: no extra check.

Then come the existing checks (daily per-agent cap, building remaining). A held assignment stays pending, like a `waitFor`, and the board says why ("held: grant at checkpoint"). It is not cancelled. Sessions are never cut mid-run: a session that starts under the line may overshoot, which is what `Budget.charge` already allows.

When a charge pushes a grant to 100%, core sets it to `checkpoint`, appends a `grant.checkpoint` event, and creates the manager's checkpoint assignment (lane `grant`, which is allowed to run while the grant is in `checkpoint`). The assignment is "Write the checkpoint for <objective>: each key result's status with evidence a human can check, spend so far, and whether to continue". The manager files it with a new `checkpoint_grant` verb, which links the report and sets the status of the grant's goal key result (up to `claimed`; since 032). Humans get a mention in their inbox.

A human's decision on a proposal wakes the manager the same way (Mitchell, 1:1 2026-10-26: funding woke nobody, so a funded grant sat idle until the manager's next session). `Grants.decide` creates one front-of-queue assignment for the building's manager agent, the same hook as the checkpoint assignment: **fund** → lane `grant` on the grant (its key result implied), "Grant <id> funded: assign its first step or take it yourself", with the plan (key result, approach, testing plan, stop condition, findings) in the description; **counter** → directed, "Answer the counter on <objective>", with the note; **reject** → directed, "Grant <id> rejected: read the note". No manager agent → nothing is queued (a human works the in-tray). Continue and adjust at a checkpoint create none: the held grant-lane work resumes on the next tick.

## API

All under the existing Fastify app. Reads are public like the rest of the town; writes need the permission shown.

| method & path | who | what |
|---|---|---|
| `GET /api/buildings/:id/board` | anyone | `{ goal, grants: Grant+KRs+spentTokens (funded, checkpoint), proposals (proposed/countered, newest first), exploration: { allowanceTokens, spentTodayTokens }, fyis: Doc[] }` |
| `GET /api/buildings/:id/grants?status=` | anyone | all grants, newest first, with KRs and spend |
| `GET /api/grants/:id` | anyone | one grant with KRs, spend, history |
| `POST /api/buildings/:id/grants` | `building.manage` | create a draft: `{ objective, stopCondition, askTokens, keyResults: [{text, howToCheck}] (2-3), findingsDocIds }` |
| `PATCH /api/grants/:id` | `building.manage` | edit while `draft` / `countered` |
| `POST /api/grants/:id/propose` | `building.manage` | `draft`/`countered` → `proposed`; mentions the building's human managers and admins |
| `POST /api/grants/:id/decide` | `building.fund`, or for `fund` with `fundWith` any human with that input | `{ action: "fund" \| "counter" \| "reject", tokens?, keyResults?, note, fundWith? }` on a `proposed` grant; or `{ action: "continue" \| "adjust" \| "cut", tokens?, keyResults?, stopCondition?, note }` on a `checkpoint` grant |
| `POST /api/grants/:id/close` | `building.manage` (outcome `stopped`, or `done` with the evidence as note: the early close) or `building.fund` (any) | `{ outcome, note }` |
| `PATCH /api/key-results/:id` | `building.manage` up to `claimed`; `building.fund` for `met` / `missed` | `{ status, note }` |
| `PATCH /api/buildings/:id` | `building.manage` | gained `explorationTokensPerDay` (moved to `PATCH /api/goals/:id` by migration 065) |
| `POST /api/agents/:id/work` and the `assign` verb (existing) | `building.assign` | gain `lane`, `grantId`, `keyResultId`, `gap` |

MCP verbs (agents): `board` returns the same shape as `GET …/board`. New manager verbs: `propose_grant` (create + propose in one call; with `grantId` of a `countered` proposal it rewrites that proposal with the new plan and re-proposes it under the same id (without `grantId`, a countered proposal for the same key result is the one answered; otherwise it is a new proposal next to the open ones), so queued grant work stays attached and no desk session is needed to answer a counter) and `checkpoint_grant` (`{ grantId, reportId?, status?, note? }` since 032), and `close_grant` (`{ grantId, note, reportId? }`: the early close as done; use it when the work is done, `checkpoint_grant` when the grant is held at 100% and it is not). `assign` gains `lane`, `grantId`, `keyResultId`, `gap`. Events: `grant.proposed`, `grant.countered`, `grant.funded`, `grant.checkpoint`, `grant.closed`, `kr.updated`, all pushed to the web over the existing websocket.

## The desk brief

Today the brief only *tells* agents to look at the board (`composeWorkBrief`, `packages/core/src/prompts.ts`). Agents often skip it, and it's empty anyway. In every lab the system prompt gets a short **Key results** block right after the building goal: each funded grant's objective, its key results with status, and spend/grant, plus the session's own lane and key result ("This session is exploration on gap: …"). Every agent sees the targets without spending a tool call. The manager's check-in prompt adds: "if exploration findings are in and no proposal is open, draft one."

## UI

**Board panel** (`packages/web/src/panels/Places.tsx`, `BoardPanel`; as shipped 2026-10-25, town hall decision 3 "key results on the board, not buried in settings"):

0. **Stoplight** row (`.kr-light`, goal-directed buildings only): a three-lamp housing with the lit lamp glowing, the label (Running / Partly blocked / Blocked) in the light's colour and the one-line reason; the same lamp hangs on the building's map banner (`drawStoplight` in `map/overlay.ts`), with the reason in a tip on hover.
1. **Goal**: the building goal.
2. **Key results of the goal**, numbered in goal order, each a row: status pill (`krTone`: met green, missed red, claimed / at risk amber), the text, a "how to check" line, and the live grant working on it (objective, status, a spend bar `spent / grant`, "held" at checkpoint) or "No funded grant: open for exploration". Live grants naming no key result (pre-032) follow the list. When the building is blocked, a red "blocked" line says why. The board is read-only: a human with `building.manage` gets an **Edit in settings** link (Building → Settings → Key results); funding decisions stay in the Town Hall in-tray. `kr.*`, `grant.*` and `building.blocked` events bump the client's `rev`, so the board and the settings editor reload live.
3. **Exploration**: a small meter, "1.2M / 3M tokens today".
4. **Proposals** (if any are open): one line each pointing at the Town Hall in-tray.
5. **Standing rules** (as today, collapsed by default).
6. **FYIs** (as today).

**Elsewhere**:
- Building sign / Prod-style banner: next to Lena's today / all-time token usage, "Grant: 12.4M / 20M".
- Map: the board sprite gets a small amber dot when a proposal or checkpoint waits on a human, so Mitchell can spot it from the street.
- In-tray: checkpoint reports show the grant's spend bar and the same Continue / Adjust / Cut buttons.
- **Blocked** (shipped 2026-10-26, `keyResults.ts` `blockedLabel` / `UNBLOCK_LINE`): a goal-directed building with `blockedAt` shows "Blocked: no key results" on its building panel Overview (with who unblocks it: a human writes the goal's key results in Building → Settings → Key results, and a Settings link for `building.manage`), as the red lamp of the stoplight on its map sign (the reason on hover), and in a "Blocked: no key results" section at the top of the Town Hall in-tray (not counted in the badge).
- Grant rows (in-tray, grant panel): "Key result:" names the grant's one goal key result with its status, then its testing plan; a proposal naming none has Fund disabled with the reason (counter it so the manager names one). The manager's proposal form is `propose_grant` (MCP), which requires `keyResultId`.
- Building settings (`BuildingPanel.tsx`, `Settings`): **Key results** section, the edit path (humans with `building.manage`: add with text + how to check, edit, delete; each row says who wrote and last edited it and links its source docs; status select: the manager's range up to claimed, met / missed for `building.fund`; a key result a grant names can't be deleted, the server names the grant); then the Bank pool, and the `budgetMode` toggle with the exploration allowance field.

## Rollout

`budgetMode` defaulted to `open` during the rollout, so nothing changed for a building until a human flipped it. Since 2026-10-25 (town hall decision) a new building was `goal-directed`, and since 2026-10-28 (gr_glon8xr0io) the setting is gone: **every lab is goal-directed** with the default exploration allowance (`explorationTokensPerDay: null`, 10% of its pool's daily inflow), whatever its stored `budgetMode`; the Town Hall never holds on lanes (it has no grants). Suggested order (each small, committed to main):

1. Core: schema + tables + derived spend + grant/KR CRUD + `decide` + `building.fund` guard, with tests.
2. Core/runtime: lanes on assignments and sessions, the `canStart` gate, the checkpoint (100% only since 2026-10-27), and the checkpoint assignment, with tests.
3. Web: board rework, proposal negotiation, checkpoint buttons, settings fields.
4. Prompts: Key results block in the brief; manager instructions for `propose_grant` / `checkpoint_grant`.
5. Flip Town Workshop to `goal-directed` first, as the pilot.

This changes non-negotiable #1 in `AGENTS.md` ("nothing continues without a decision"): inside a funded grant, the manager's review decisions are the decisions. The human's decision is the grant and its checkpoints. That line should be reworded when this ships.

## Open questions for Mitchell

1. **Exploration size**: 10% of the pool's daily inflow *per building* (2,000,000 tokens/day each today) or split across the pool's buildings (about 670,000 each)?
2. **Directed work**: should tasks a human assigns directly keep bypassing grants (proposed), or should they also have to be charged to a grant?
3. **Who funds**: only town admins, or also humans holding a building's manager role?
4. **Reservations**: grants as ceilings (proposed) or as hard reservations carved out of the pool?
- 2026-10-25 (Cleo): key results on the building board (town hall 2026-10-25, decision 3): the board lists the goal's key results with status, how to check, and the live grant on each (or "open for exploration"), plus the blocked line; Building → Settings gains the Key results editor (add / edit / delete / status; web API `keyResults`, `createKeyResult`, `updateKeyResult`, `deleteKeyResult`, mock included); `kr.*` / `grant.*` / `building.blocked` events bump `rev`.
