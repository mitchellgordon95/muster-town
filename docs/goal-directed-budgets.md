# Goal-directed budgets — design

Status: **proposal, waiting for Mitchell's review** (decided in the Town Workshop standup of 2026-10-21, notes `dc_taoar1c9ag`). Nothing here is built yet.

## Why

Mitchell doesn't trust open-ended automation, and shouldn't have to. Nor should a human have to approve every task. The gate moves from individual tasks to a **funded building proposal**: the building's manager proposes an objective with a few key results that a human can check in the live town, plus a token ask. The human negotiates it, funds it, and checks in at half spend. Inside a funded grant, agents work as they do today. Outside one, a building only gets a small exploration allowance, and every exploration task has to point at the goal.

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
          │ spend crosses 50%
   ┌──────▼───────┐  new sessions on the grant pause; manager writes a checkpoint report
   │ checkpoint   │  human: continue / adjust (tokens, KRs) / cut
   └──────┬───────┘
          │ KRs met (human confirms) · stop condition hit · tokens spent · cut
       closed
```

1. **Exploration (goal-scoped).** Each building has a daily exploration allowance. An exploration assignment has to name either a key result (of a funded or proposed grant) or a *goal gap*: one sentence on what is missing between the goal and the live town ("a visitor can't tell what Prod is for"). Its output is the session report, which works as a findings note. Nothing open-ended: an assignment without a key result or gap is rejected when it is created.
2. **Proposal (building level, by the manager).** The manager bundles findings into one proposal: an objective, 2-3 key results, a token ask, and a stop condition. Key results must be **human-observable**: something a person can see in the live town, with a "how to check" line ("open the Prod banner: it shows today's and all-time tokens"). "Tests pass", "N commits" or "PR merged" don't count, because agents grade their own work generously. A building has at most one proposal open at a time, so the human reviews one coherent plan instead of competing asks.
3. **Negotiation.** The human funds it as is, funds it with fewer tokens, counters (edits key results or tokens with a note, and it goes back to the manager), or rejects it. Every step is kept in the grant's history.
4. **Execution.** Once funded, the manager and residents work freely inside the grant: the manager assigns tasks against its key results, reviews reports, and continues work; residents commit and deploy as now. Outward-facing actions (`request_human`, anything in the real world) stay human-gated as today.
5. **Checkpoint at 50% spend.** When the grant's spend crosses half its tokens, new sessions on it are held (running ones finish). The manager gets an assignment, charged to the grant, to write a checkpoint report: each key result's status with evidence a human can check. The human continues, adjusts (tokens, key results, stop condition), or cuts the rest. A grant that reaches 100% is held the same way and can only be topped up or closed.
6. **Close.** A grant closes when the human marks its key results met, when the stop condition is hit, or when it is cut. Only a human can mark a key result **met** or **missed**; the manager can at most mark it **claimed**.

### Three spend lanes

Every assignment, and so every session, runs in exactly one lane:

| lane | what | gated by |
|---|---|---|
| `grant` | work toward a funded grant's key results | grant is `funded` and below its checkpoint / cap |
| `exploration` | goal-scoped investigation (names a key result or a goal gap) | building's exploration spend today < allowance |
| `directed` | a human asked for it directly: created by a user, or a decision of a meeting a human spoke in | today's rules (daily per-agent cap, pool) |

Agents can't create `directed` work. When a manager agent creates an assignment, it has to say `grant` (with a key result) or `exploration` (with a key result or gap). Continuations (review `continue` / `redirect`, parked `resumeWhen` chains, retries) inherit the lane of the assignment they come from. Check-in sessions (no assignment) count as exploration.

### Sizes, with today's numbers

Live Bank on 2026-10-21: one pool (General, 100%), a subscription input crediting 20,000,000 tokens/day (weekly cap 140,000,000), plus a one-off 50,000,000-token API-key input with about 39,000,000 left. General feeds Town Workshop, Onboarding and Prod (the Town Hall draws nothing).

The Workshop's last 38 session reports spent a median of about 950,000 tokens each (range 210,000 to 10,600,000).

- **Exploration allowance.** Proposal: **10% of the building's pool's daily inflow, per building, not split.** For General that is 2,000,000 tokens/day for each building, about two median sessions. Splitting 10% across the three drawing buildings would give about 670,000 each, which is less than one median session, so it's too small to explore anything. The value is stored per building (`explorationTokensPerDay`) so a human can just set it. The 10% figure is only the default.
- **A grant.** A typical first ask would be 10,000,000 to 30,000,000 tokens (roughly 10 to 30 median sessions). Grants are **ceilings, not reservations**: the pool still pays first come, first served. The board warns when a building's open grants add up to more than its pool can fund over the grant's window (e.g. more than 7 days of inflow for a one-week grant).

## Data model

New schema in `packages/schema/src/index.ts`, with SQLite tables in core (`grants`, `key_results`) the same way pools were added.

```ts
export const GrantStatus = z.enum([
  "draft",       // manager is writing it; only the building sees it
  "proposed",    // waiting for a human
  "countered",   // a human sent it back with changes; manager's move
  "funded",      // execution: sessions may draw on it
  "checkpoint",  // spend crossed 50% (or 100%): new sessions held until a human decides
  "closed",      // done: see outcome
  "rejected",
]);
export const GrantOutcome = z.enum(["met", "stopped", "spent", "cut"]);

/** A building's proposal and, once funded, its grant: one objective, 2-3 key results, a token ceiling. */
export const Grant = z.object({
  id: Id,
  buildingId: Id,
  objective: z.string().min(1).max(300),
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
  /** spend fractions already checkpointed (0.5, 1), so each fires once per grantTokens value */
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
  grantId: Id,
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
budgetMode: z.enum(["open", "goal-directed"]).default("open"),                 // rollout switch, per building

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

- **Spend is derived, not stored**: a grant's spend is `SUM(sessions.tokens WHERE grantId = ?)`, and today's exploration spend is the same sum over `lane = 'exploration'` sessions of the building started since 00:00 UTC. No second counter that can drift from `Budget.charge`. `Budget.charge` only has to check the 50% / 100% thresholds after each charge.
- **`building.fund` is never effective for agents**: `Permissions.can` returns false for agent holders regardless of roles. The manager agent already holds `building.manage`, and an owner's permissions cap their agents', so without this an agent manager whose owner is admin could fund its own proposal.
- Exploration's "names a key result or gap" is enforced when the assignment is created: `lane = exploration` requires `keyResultId` or a non-empty `gap`; `lane = grant` requires `grantId` and `keyResultId` of that grant.

## Gate (runtime)

`Budget.canStart(agentId)` becomes `canStart(agentId, assignment)`. It is the single place the scheduler (`packages/runtime/src/index.ts`) and `work.ts` already check. In `goal-directed` buildings it adds:

- `grant`: the grant is `funded` (not `checkpoint` / `closed`).
- `exploration`: the building's exploration spend today < its allowance.
- `directed`: no extra check.

Then come the existing checks (daily per-agent cap, building remaining). A held assignment stays pending, like a `waitFor`, and the board says why ("held: grant at checkpoint"). It is not cancelled. Sessions are never cut mid-run: a session that starts under the line may overshoot, which is what `Budget.charge` already allows.

When a charge pushes a grant past 50% (or 100%), core sets it to `checkpoint`, appends a `grant.checkpoint` event, and creates the manager's checkpoint assignment (lane `grant`, which is allowed to run while the grant is in `checkpoint`). The assignment is "Write the checkpoint for <objective>: each key result's status with evidence a human can check, spend so far, and whether to continue". The manager files it with a new `checkpoint_grant` verb, which links the report and sets KR statuses (up to `claimed`). Humans get a mention in their inbox.

## API

All under the existing Fastify app. Reads are public like the rest of the town; writes need the permission shown.

| method & path | who | what |
|---|---|---|
| `GET /api/buildings/:id/board` | anyone | `{ goal, grants: Grant+KRs+spentTokens (funded, checkpoint), proposal (proposed/countered, if any), exploration: { allowanceTokens, spentTodayTokens }, fyis: Doc[] }` |
| `GET /api/buildings/:id/grants?status=` | anyone | all grants, newest first, with KRs and spend |
| `GET /api/grants/:id` | anyone | one grant with KRs, spend, history |
| `POST /api/buildings/:id/grants` | `building.manage` | create a draft: `{ objective, stopCondition, askTokens, keyResults: [{text, howToCheck}] (2-3), findingsDocIds }` |
| `PATCH /api/grants/:id` | `building.manage` | edit while `draft` / `countered` |
| `POST /api/grants/:id/propose` | `building.manage` | `draft`/`countered` → `proposed`; mentions the building's human managers and admins |
| `POST /api/grants/:id/decide` | `building.fund` | `{ action: "fund" \| "counter" \| "reject", tokens?, keyResults?, note }` on a `proposed` grant; or `{ action: "continue" \| "adjust" \| "cut", tokens?, keyResults?, stopCondition?, note }` on a `checkpoint` grant |
| `POST /api/grants/:id/close` | `building.manage` (outcome `stopped`) or `building.fund` (any) | `{ outcome, note }` |
| `PATCH /api/key-results/:id` | `building.manage` up to `claimed`; `building.fund` for `met` / `missed` | `{ status, note }` |
| `PATCH /api/buildings/:id` | `building.manage` | gains `explorationTokensPerDay`, `budgetMode` |
| `POST /api/agents/:id/work` and the `assign` verb (existing) | `building.assign` | gain `lane`, `grantId`, `keyResultId`, `gap` |

MCP verbs (agents): `board` returns the same shape as `GET …/board`. New manager verbs: `propose_grant` (create + propose in one call) and `checkpoint_grant` (`{ grantId, reportId, keyResults: [{id, status, note}] }`). `assign` gains `lane`, `grantId`, `keyResultId`, `gap`. Events: `grant.proposed`, `grant.countered`, `grant.funded`, `grant.checkpoint`, `grant.closed`, `kr.updated`, all pushed to the web over the existing websocket.

## The desk brief

Today the brief only *tells* agents to look at the board (`composeWorkBrief`, `packages/core/src/prompts.ts`). Agents often skip it, and it's empty anyway. In `goal-directed` buildings the system prompt gets a short **Key results** block right after the building goal: each funded grant's objective, its key results with status, and spend/grant, plus the session's own lane and key result ("This session is exploration on gap: …"). Every agent sees the targets without spending a tool call. The manager's check-in prompt adds: "if exploration findings are in and no proposal is open, draft one."

## UI

**Board panel** (`packages/web/src/panels/Places.tsx`, `BoardPanel`), reworked top to bottom:

1. **Goal**: the building goal, large.
2. **Funded key results**: one card per funded / checkpoint grant:
   - objective and stop condition;
   - a spend bar `spent / grant` with a tick at 50%, coloured by status (funded, checkpoint: amber, held);
   - key results as rows: text, a "how to check" line, status pill. A human with `building.fund` gets Met / Missed buttons; the manager gets On track / At risk / Claimed;
   - on `checkpoint`: the checkpoint report link and **Continue / Adjust / Cut** for humans.
3. **Proposal** (if one is open): objective, KRs, ask, stop condition, linked findings, and the history thread. Humans get **Fund** (with a token field prefilled to the ask), **Counter** (edit fields + note) and **Reject**. Everyone else sees "Waiting for a human".
4. **Exploration**: a small meter, "Exploration today: 1.2M / 2.0M tokens", with the latest exploration reports and the gap each one named.
5. **Standing rules** (as today, collapsed by default).
6. **FYIs** (as today).

**Elsewhere**:
- Building sign / Prod-style banner: next to Lena's today / all-time token usage, "Grant: 12.4M / 20M".
- Map: the board sprite gets a small amber dot when a proposal or checkpoint waits on a human, so Mitchell can spot it from the street.
- In-tray: checkpoint reports show the grant's spend bar and the same Continue / Adjust / Cut buttons.
- Building settings: `budgetMode` toggle and exploration allowance field.

## Rollout

`budgetMode` defaults to `open`, so nothing changes for a building until a human flips it. Suggested order (each small, committed to main):

1. Core: schema + tables + derived spend + grant/KR CRUD + `decide` + `building.fund` guard, with tests.
2. Core/runtime: lanes on assignments and sessions, the `canStart` gate, the 50% / 100% checkpoint, and the checkpoint assignment, with tests.
3. Web: board rework, proposal negotiation, checkpoint buttons, settings fields.
4. Prompts: Key results block in the brief; manager instructions for `propose_grant` / `checkpoint_grant`.
5. Flip Town Workshop to `goal-directed` first, as the pilot.

This changes non-negotiable #1 in `AGENTS.md` ("nothing continues without a decision"): inside a funded grant, the manager's review decisions are the decisions. The human's decision is the grant and its checkpoints. That line should be reworded when this ships.

## Open questions for Mitchell

1. **Exploration size**: 10% of the pool's daily inflow *per building* (2,000,000 tokens/day each today) or split across the pool's buildings (about 670,000 each)?
2. **Directed work**: should tasks a human assigns directly keep bypassing grants (proposed), or should they also have to be charged to a grant?
3. **Who funds**: only town admins, or also humans holding a building's manager role?
4. **Reservations**: grants as ceilings (proposed) or as hard reservations carved out of the pool?
