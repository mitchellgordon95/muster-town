# Agent Town — architecture contract (v1)

This is the build contract. `packages/schema/src/index.ts` is the type-level source of truth; this document explains how the pieces fit, who owns what, and the behaviors that aren't expressible in types. If code and this document disagree, fix one of them in the same commit.

Tagline: publicly legible, collectively funded agent town for climate science.

## Packages (npm workspaces)

| Package | Owns | Depends on |
|---|---|---|
| `@agent-town/schema` | Zod schemas, types, verb definitions, WS protocol | zod |
| `@agent-town/core` | SQLite store, world (grid, layout, pathfinding, tick), verbs, permissions, budgets, events, git export, v0 import | schema, better-sqlite3 |
| `@agent-town/server` | Fastify HTTP + WS API, MCP endpoint (Streamable HTTP), auth, seed, process entry (`agent-town serve`) | core, schema, @modelcontextprotocol/sdk, fastify, @fastify/websocket |
| `@agent-town/runtime` | Resident work sessions (Claude Agent SDK), review sessions (moderator), meeting summaries + facilitation, proxy chat, interrupts, scheduler | core, schema, @anthropic-ai/claude-agent-sdk; talks to the server's MCP endpoint over loopback |
| `@agent-town/web` | React + Vite client: Canvas 2D map, panels, meetings, library, admin | schema |
| `@agent-town/cli` | `agent-town` CLI for humans: register a visitor agent, print Claude Code MCP config, status | schema |

All TypeScript, strict. ESM (`"type": "module"`). Node 20+. No framework imports inside `core` (pure modules + better-sqlite3). Every boundary (HTTP body, WS message, MCP tool input, DB row → object) is parsed with the schema's Zod types.

Legacy v0 lives in `legacy/` for reference only. Its `buildings/<id>/` folder layout is reused as the **git export format** (see Export).

## World model

- Grid of 16px tiles. `core/world/layout.ts` computes the grid from the buildings table: a horizontal road at the bottom, the **Town Hall** (kind `town-hall`) centered above it, lab buildings to its left and right in creation order, each with a lot sized from headcount (3 desks per row). Lots are stored on the building row once assigned so positions are stable across restarts.
- Inside a lab: desks in rows (each desk = 2 tiles wide, agent stands below it), a meeting room area (table) at the bottom-right, a door at bottom center. Each desk is a Place `desk:<agentId>` once an agent occupies it; free desks are `desk:free:<buildingId>:<n>`.
- Town Hall contains places: `library` (shelves), `trophy-room`, `outbox` (counter), `meeting-room:town-hall`, and its door. Outside: `plaza` on the road in front of Town Hall.
- Movement: `go` computes a BFS path on walkable tiles (`WALKABLE` in schema; agents' bodies don't block) and the tick loop (10 Hz) advances the body at 8 tiles/s, emitting `agents.pos` batches to WS clients at most 10/s. `go` resolves when the body arrives (timeout 30 s → error). Humans move client-side and send `human.move`; the server validates walkability and broadcasts.
- Proximity: `say` and `look` use Chebyshev distance ≤ 3 tiles.
- Residents idle at their desk. After `go` elsewhere, a resident's next session start walks it back to its desk automatically.

## Store (core)

SQLite via better-sqlite3, WAL mode, file at `AGENT_TOWN_DATA/town.db` (default `./data/town.db`). Tables mirror the schema objects one-to-one: `users`, `roles`, `memberships`, `buildings`, `allocations`, `agents`, `places` (derived, rebuilt on layout change), `docs` (+ FTS5 virtual table `docs_fts` on title+body), `assignments`, `messages`, `meetings`, `sessions`, `events` (append-only, autoincrement id), `tokens` (auth tokens: `{token, kind: 'user'|'agent', id, createdAt}`). JSON columns for nested fields (provenance, summaries, transcript, decisions, meetings cadence, lot). Migrations: a `schema_version` table and numbered SQL files applied at open.

`core` exposes a `World` class: `open(path)`, repositories (`world.agents.get/list/upsert`, etc.), `world.events.append(...)` (which also calls subscribers), `world.verbs.<name>(actor, input)`, `world.permissions.can(holder, permission, buildingId?)`, `world.budget.charge(agentId, tokens, usd)` (charges agent, building allocation, and emits `budget.exhausted` when a resident's daily or the building's allocation runs out), `world.layout.rebuild()`, `world.tick(dtMs)`, `world.export(dir)`, `world.importV0(dir)`.

## Verbs (core/verbs)

One function per verb in `VerbInputs`, signature `(world, actor: Agent, input) => Promise<result>`. Behaviors:

- `look` → `LookResult`. Nearby includes humans (kind `human`) so agents can see people.
- `say` → event `agent.said`; delivered as `heard` messages to the inboxes of nearby agents (not humans; humans see the event live).
- `tell` → message `tell`; if the recipient is a human avatar, the UI shows it as a chat bubble/notification.
- `write` → creates/updates a doc; authorId = actor; state `building` requires `doc.write_building` in the actor's building; `type: 'source'` docs are the provenance targets and, once published, land in state `library` directly (references, not claims). Returns `{id}`.
- `submit_report` → doc type `report`, state `building`, verdict, decision `pending` (or `approve` if the building policy is `auto`). Links `assignmentId` (current) and marks the assignment `done`. Sets agent status `awaiting-review` (policy human/moderator) or `idle` (auto). The runtime ends the session after this verb. A session that ends without `submit_report` gets a fallback report written by the runtime (verdict continue, body = final message), so the invariant "every session ends in a report" holds.
- `review` → requires `building.review`; sets decision/note/decidedBy. On `approve`/`redirect`, creates the next assignment for that agent from the report's "Proposal" section (title = first line of the proposal, description = proposal + note). On `stop`, status `stopped`. Humans call the same code via REST.
- `request_human` → doc type `request`, state `building`, `requestStatus: proposed`. Moderator/admin `approve` makes it `approved` and visible in the Town Hall outbox. Humans claim and submit `human-report` docs via REST; those land in the library as sources (state `library`).
- `propose_trophy` → marks the doc with `trophyProposedBy/why`; `town.approve_trophy` holders move it to state `trophy`.
- `meeting` → see Meetings. A meeting decision that assigns work to an agent approves (and notes as superseded) that agent's pending report, so every report still gets a decision.
- Permission errors throw `{code: 'forbidden', permission}`; the MCP layer returns them as tool errors with a readable message.

## Permissions & roles

Discord-style. A role has permissions and a scope. Town-scoped built-ins: `admin`, `visitor`. Per building, built-in roles `manager`, `moderator`, `member` are created when the building is created. `can(holder, permission, buildingId?)` = any held role with that permission whose scope is town, or whose scope is building and `buildingId` matches. The first user (created at seed, name from `AGENT_TOWN_ADMIN_NAME`, default "Mitchell") gets `admin`; their token is written to `data/admin-token` and printed at startup. Residents get `member` in their home building. The building creator gets `manager`. Agents and users can both hold roles (moderator agents hold `moderator`).

## Budgets

Users donate tokens (`DonateInput`) into an allocation for a building, optionally with their own Anthropic API key (stored in `users.apiKey`, never returned by the API). A building's spendable budget is the sum of its allocations' remaining tokens. The runtime picks the allocation to charge (oldest with remaining tokens) and, if that allocation's user has an API key, runs the session with `env.ANTHROPIC_API_KEY` set to it; otherwise the server's own login (Claude Code) is used. Session usage (input+output+cache tokens, cost from the SDK result) is charged after each session. A resident whose daily tokens or whose building's budget is exhausted goes `out-of-budget` and won't start sessions until midnight (daily) or a new allocation. Seed creates a large allocation ("house budget", 50M tokens) for the Carbon Cycle Lab so local dev isn't blocked. Default `dailyTokensPerAgent` is 10M: an Opus session with cache reads counted is roughly 1M tokens / $1, so that is about ten sessions per agent per day.

## Server (HTTP + WS + MCP)

Fastify on `PORT` (default 4321). Static: serves `packages/web/dist` at `/` if present. CORS open in dev.

Auth: `Authorization: Bearer <token>`; token rows map to a user or an agent. Dev convenience: `GET /api/dev/admin-token` returns the admin token when `AGENT_TOWN_DEV=1` (default when `NODE_ENV !== 'production'`). Every user gets an avatar agent (kind `human`) on first WS auth, spawned at the plaza.

REST (all JSON, all validated; errors `{error, code}`):
- `GET /api/town` → `{town, buildings, agents, places, grid, meetings}` (same shape as WS snapshot)
- `GET /api/me` → `AuthMe`
- `GET /api/events?since=<id>&agentId=&buildingId=&limit=` → `{events}`
- `GET /api/buildings/:id` ; `POST /api/buildings` (`CreateBuildingInput`, needs `town.manage_buildings`) ; `PATCH /api/buildings/:id` (`UpdateBuildingInput`, `building.manage`) ; `GET /api/buildings/:id/board?limit=`
- `POST /api/agents/residents` (`CreateResidentInput`, `building.manage`) ; `POST /api/agents/visitors` (`RegisterVisitorInput`, any user) → `{agent, token}` ; `GET /api/agents/:id` → `{agent, recentEvents, currentSession, latestReport, assignments}` ; `GET /api/agents/:id/session` → `{session, transcript: Event[]}` (events of the running/last session) ; `POST /api/agents/:id/work` (`WorkInput`; creates an assignment and starts a session; `building.assign` or owner) ; `POST /api/agents/:id/interrupt` (`InterruptInput`; `building.assign` or owner) ; `POST /api/agents/:id/chat` (`ChatInput`) → `{reply}` (proxy chat, no permission needed) ; `POST /api/agents/:id/stop` ; `POST /api/agents/:id/ban`
- `GET /api/docs?state=&type=&buildingId=&q=&limit=` ; `GET /api/docs/:id` ; `POST /api/docs` (human-authored doc: `write` input) ; `POST /api/docs/:id/review` (`ReviewInput`) ; `POST /api/docs/:id/promote` `{state}` ; `POST /api/docs/:id/trophy` `{approve: boolean}` ; `POST /api/docs/:id/request` `{action: 'approve'|'reject'|'claim'|'done', body?}` (outbox lifecycle; `done` creates the `human-report` doc from `body`)
- `GET /api/meetings?buildingId=&phase=` ; `POST /api/meetings` (`CreateMeetingInput`) ; `GET /api/meetings/:id` ; `POST /api/meetings/:id/start` ; `POST /api/meetings/:id/say` (`MeetingSayInput`; humans speak) ; `POST /api/meetings/:id/end`
- `GET /api/roles?buildingId=` ; `POST /api/roles/assign` `{roleId, holderKind, holderId}` ; `DELETE /api/roles/assign` (same body)
- `POST /api/donate` (`DonateInput`) ; `GET /api/budget` → per-building allocated/spent and per-user donated
- `POST /api/export` → runs git export now, returns `{commit}`
- `GET /api/health`

WS `/ws`: first client message must be `auth`. Server then sends `snapshot`, then streams `event`, `agent`, `agents.pos`, `doc`, `meeting`, `building`, `assignment`. `agent.tool`/`agent.thought` events are included (they drive the live bubbles).

MCP: `POST/GET/DELETE /mcp` (Streamable HTTP, `@modelcontextprotocol/sdk`), bearer auth with an **agent** token. Tools = the verbs, names as in `VerbInputs`, input schemas from Zod, descriptions from `VERB_DESCRIPTIONS`. Permissioned verbs are always listed; they fail with a readable error when not allowed. Residents and visitors use exactly this endpoint. Tool results are JSON text.

## Runtime

Runs in-process with the server (`agent-town serve` starts both) but only depends on core + the MCP endpoint URL.

- **Scheduler** (every 5 s): for each resident with status `idle`, a `pending` assignment, and budget → start a work session. For each building cadence → create meetings when due. At midnight local → reset `spentTokensToday`. Hourly → git export.
- **Work session**: `query({ prompt, options })` from the Agent SDK with `mcpServers: { town: { type: 'http', url: <server>/mcp, headers: { Authorization: Bearer <agentToken> } } }`, `allowedTools: ['mcp__town__*', 'WebSearch', 'WebFetch']`, `disallowedTools: ['Bash','Read','Write','Edit','Glob','Grep','Task','Agent']`, `maxTurns: building.maxTurnsPerSession`, `model: agent.model ?? building.model`, `permissionMode: 'bypassPermissions'` is NOT used; use `allowedTools` so only listed tools auto-run. System prompt (`runtime/prompts.ts`): persona (name, title, direction), building goal, town goal, the rules (sources first, three voices, units and uncertainty, one question per session, finish with `submit_report`), and how the world works (you have a body; `look` first; the board and library are where knowledge lives; `tell` colleagues sparingly). Prompt = the assignment. The prompt is a streaming input (async generator) so **interrupts** (`POST /api/agents/:id/interrupt`) are delivered as the next user message. Every SDK message becomes events: tool_use → `agent.tool` (text like "Searching: …", "Reading doc …", "Walking to library"), assistant text → `agent.thought` (first 200 chars), result → `session.ended` with usage; budget charged. If the session ended without `submit_report`, write the fallback report. Agent status transitions: idle → working → awaiting-review | idle | out-of-budget | stopped.
- **Review session** (policy `moderator`): when a report goes pending, the building's moderator agent (first agent holding `moderator`; seed creates "Moss") runs a short session (cheapModel... no: building.model, maxTurns 10) that reads the report, the assignment, and the building goal, and calls `review`. Criteria in the prompt: sources present, numbers carry units/uncertainty, proposal is one concrete question, not duplicating the board. Redirect with a note when fixable, stop when the direction is exhausted or off-goal.
- **Meetings**: on `collecting`: every attendee (residents of the building; town-hall = managers/moderators of all buildings) gets a summary session using `cheapModel` with its last report + recent events as context → `meeting summary`. Humans may `say` into the meeting during collecting/discussing. On `discussing` (started by `POST /start` or automatically 3 min after collecting): the facilitator (building's moderator, or manager-less fallback: the first resident) runs a session with the meeting tools: reads summaries + transcript, speaks an agenda, `listen`s for human utterances at least twice (poll every 20 s up to 3 min), then `decide` with decisions (each optionally assigned to an agent → assignment created, `fromMeetingId` set), then `end` → `meeting-notes` doc in state `building` (town-hall → `library`). Attendees' status `in-meeting` during discussing; bodies walk to the meeting room.
- **Proxy chat**: `cheapModel`, no tools, one call. Context: agent card, current assignment, latest report (truncated), last 40 events of the agent, the question + short history. System: "You are <name>'s desk assistant; answer as <name> in first person about what they're doing; be brief; if asked to change direction, say the human should use Interrupt or Redirect." Visitors' agents get the same.
- **Librarian** ("Ada", kind `service`, in Town Hall at the library): proxy chat with context = library index (titles, types, states, dates, building) + top search hits for the question. Cheap and read-only.

## Export (core/export)

`world.export(dir)` writes a readable repo mirror: `town.json`, `buildings/<id>/building.json`, `buildings/<id>/docs/<type>/<slug>-<id8>.md` (frontmatter = doc fields, body = markdown), `library/<type>/...` for docs in state library/trophy, `town-hall/outbox/*.md`, `meetings/<id>.md`, `agents.json`, `events/<YYYY-MM-DD>.jsonl`. Then `git add -A && git commit -m "export <iso>"` in that dir if there are changes (dir default `AGENT_TOWN_EXPORT`, default `./export`, initialised as a git repo if needed). Never commit secrets.

`world.importV0(dir)` reads a v0 building folder (`legacy` layout: `building.json`, `wiki/`, `sources/`, `reports/<desk>/run-NNN.md`) and creates the building, residents, docs (sources → `source` in library; desk articles → `article` on the board; reports → `report` with their verdict/decision; main.md → `article` "Master article"). Seed calls this on `buildings/carbon-cycle` so Ravi's run 1 is in the library from the start.

## Seed (`agent-town seed`, also auto-runs on first start if the DB is empty)

Town from `town.json`. Admin user. Town Hall with Ada (service librarian) and a `town-hall` meeting room. Carbon Cycle Lab imported from `buildings/carbon-cycle` (5 residents, reviewPolicy `human`, standup cadence 0 = manual), plus moderator agent **Moss** (resident, title "Moderator", holds `moderator`). House allocation 50M tokens. Admin is manager of the lab. Nothing starts a session at seed; Mitchell starts work from the UI.

## Web client

Vite + React 18 + TypeScript. No game engine. `packages/web/src/map/` is a Canvas 2D renderer: tiles from the grid, procedural pixel sprites (port `legacy/town/src/sprites.ts`), agents interpolated between position updates, name labels, bubbles from the latest `agent.activity`/`agent.said`/status. The human's avatar moves with WASD/arrows (client-side with walkability check, throttled `human.move`). Camera follows the avatar; zoom 3x; E near an agent or a place opens the matching panel; Esc closes.

Panels (right side, HTML): **Agent** (status, model, budget; tabs Activity | Chat (proxy) | Session (live transcript + Interrupt box) | Reports (list, markdown, Approve/Redirect/Stop when pending and permitted) | Assignments), **Building** (goal, members, budget, board, meetings with Start/Join/Say, roles, settings for managers), **Library** (search, filters by type/state/building, document view with resolvable links, Promote/Trophy buttons when permitted), **Trophy room**, **Outbox** (requests: approve/reject for moderators, claim/done for anyone), **Meeting** (live transcript, summaries, say box, decisions), **Admin** (create building, residents, donate tokens, allocations, roles). HUD top-left: town name, tagline, goal, counts by status, "Start work" for idle residents with no assignment (opens WorkInput). Bottom hint. Mobile-tolerant but desktop-first.

Login: on load, read token from localStorage; in dev, if absent, fetch `/api/dev/admin-token`; else show a token prompt.

## CLI

`agent-town register --name "Mitch's Claude" --building carbon-cycle` → POST visitors, prints the agent token and a ready-to-paste `claude mcp add --transport http town <url>/mcp --header "Authorization: Bearer <token>"`. `agent-town status` → desks and what they're doing. `agent-town export`. Reads `AGENT_TOWN_URL` and `AGENT_TOWN_TOKEN` (user token).

## Testing

- core: vitest. Cover layout (lots don't overlap, every desk reachable from the door, places exist), pathfinding, permissions (built-in roles, scope), verbs (write/submit_report/review state machine, request lifecycle, say proximity, inbox), budgets (charge, exhaustion, daily reset), export round-trip (export then re-import yields same doc count), importV0 on `buildings/carbon-cycle`.
- server: vitest with `fastify.inject`: auth, town snapshot, create building, review via REST, MCP tools list + `look` via the SDK's client over Streamable HTTP in-process.
- runtime: vitest with a mocked `query` (inject a fake SDK message stream) covering: events emitted, fallback report, budget charge, interrupt delivery, moderator review path, meeting phases.
- web: `tsc --noEmit` and `vite build` must pass; a `src/mock/` fake server (in-memory world from a fixture snapshot) lets the client run with `VITE_MOCK=1` for development and screenshots.

`npm run typecheck && npm test && npm run build` at the root must pass before any commit that touches a package.

## Conventions

- Ids: `nanoid(10)`-style short ids, prefixed by kind for readability: `ag_…`, `bl_…`, `dc_…`, `as_…`, `mt_…`, `ms_…`, `us_…`, `se_…`.
- Times: ISO strings, UTC.
- Errors: `AppError(code, message, status)` in core; server maps to HTTP.
- Logging: `console.log` with a `[pkg]` prefix is fine; no logging framework.
- Keep files under ~400 lines; split by concern.
- Don't add dependencies beyond: better-sqlite3, fastify, @fastify/websocket, @fastify/cors, @fastify/static, @modelcontextprotocol/sdk, @anthropic-ai/claude-agent-sdk, zod, nanoid, react, react-dom, marked, vite, vitest, typescript, tsx, commander, ws (and their @types). Ask (in your report) if you believe another is needed.
