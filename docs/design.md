# Agent Town — design notes

Written 2026-10-19 from Mitchell's description plus the v0 build. Mitchell's words are marked as his; the rest is agent analysis.

## What Mitchell asked for (2026-10-19)

- He is researching the carbon cycle (how CO2 moves through atmosphere, plants, land, ocean) and feels like *he* is the bottleneck. He wants agents to carry the research.
- He liked a Twitter demo: a 2D Gather-Town-style office where agents sit at desks, you walk by, see what they're doing, and talk to them.
- A swarm where each agent explores a different direction, collaborating through a central library: a wiki in the style of his kb-bootstrap skill (AGENTS.md rules, wiki/, sources/, log/).
- Not just for him: a **shared public space** where anyone can add a room or building of their own agents. First tenant is climate research; the natural fit is nonprofit, public, collaborative, academic work.
- A **librarian** for people passing by who want to know what the project is and what progress has been made.
- **Reports**: agent runs should end in reports he can read, so he isn't the bottleneck but still has a tangible interface before they continue. Reports are either *proposals for moving forward* or *post-mortems on why the work should stop*.
- The town should have a **banner goal**, e.g. "decrease atmospheric carbon to X ppm by 20XX".
- Tenancy model: **auth with Anthropic or bring an API key, set how much compute you want to donate**, then optionally set up your own agents: your own building, or agents placed *in proximity* to other agents working on an aspect of the problem.

## Core concepts (as built in v0)

| Concept | What it is | Where it lives |
|---|---|---|
| Town | The world. One headline goal. | `town.json` |
| Building | A tenant: one research group with its own goal, rules, wiki. | `buildings/<id>/` |
| Desk | One agent with a persona and a standing direction. | `building.json` → `desks[]` |
| Run | One focused sprint by one desk (~40 tool calls). | `reports/<desk>/run-NNN.md` + `.log` |
| Report | The run's deliverable: summary, findings, proposal or post-mortem. Carries the human's decision in frontmatter. | same file |
| Decision | approve / redirect (with note) / stop. Set by the human in the town UI. Gate for the next run. | report frontmatter |
| Librarian | Read-only agent at the door who orients visitors from the wiki and reports. | `building.json` → `librarian` |
| Wiki | kb-bootstrap structure: `main.md` with open problems as the to-do list, one article per desk, source cards. | `wiki/`, `sources/`, `log/` |

**Why the report gate matters.** Unattended loops drift and burn money. A run that must end in a two-minute-readable report with a concrete proposal forces the agent to converge, gives the human a place to steer, and makes the post-mortem a first-class outcome rather than a failure. The human reads reports, never transcripts.

**Why a building is a folder.** Adding a tenant is a folder drop or a pull request. Everything is reviewable with `git diff`. No database to migrate, no admin UI needed to start. It also makes the research portable: a building can be cloned out of the town and still be a complete knowledge base.

**Why proximity.** Mitchell's instinct ("put agents in proximity to other agents working on certain aspects") maps cleanly onto the folder model: agents in the same building share a wiki and can read each other's reports. That is the whole collaboration mechanism for now. A visiting agent dropped into someone else's building gets read access to that wiki and writes its own desk article and reports there. Cross-building collaboration (a shared town-level library) is a later step, and should only come when one building's wiki is visibly not enough.

## The public town (not built yet)

Mitchell's framing: a compute-sharing collective toward one headline goal.

1. **Sign in and donate.** A visitor signs in and attaches an Anthropic API key with a monthly budget cap. (Claude Code subscription logins are per-person and can't be pooled by a third-party server, so the hosted version is API-key based; the local v0 uses your own Claude Code login.) The server runs that tenant's desks with that tenant's key and tracks spend per run; the runner already takes a per-building model/key slot.
2. **Add agents.** Either a new building (a folder with `building.json` and `AGENTS.md`, submitted as a PR or through a form that writes the same files), or desks placed inside an existing building with the owner's consent.
3. **Steer.** The building owner, not the compute donor, approves and stops runs. Donors see what their compute produced (reports credited with "run funded by @handle").
4. **Watch.** The town is public and read-only for anyone. Talking to a librarian is free (cheap read-only queries, rate-limited). Talking to a desk agent may require sign-in.
5. **Credit.** Each report's frontmatter records the funder and the model. Source cards record which run added them. That is enough for a contributors page without a reputation system.

Open questions: moderation of what buildings are allowed; whether a town-level librarian should synthesize across buildings; how to prevent two buildings from duplicating work (probably a town-level `wiki/index.md` the librarians maintain).

## Prior art

See `docs/survey-2026-10-19.md` for the full survey of existing agent-office visualizers, research swarms, and collectives.

## v0 scope and known gaps

Built: server (runner with report gate, reports API, chat with session resume, websocket activity), Phaser town with procedural sprites, side panel (activity, report with decisions, chat, article browser), Carbon Cycle Lab with five desks and a librarian.

Gaps, roughly in priority order:
- No per-run cost tracking yet (the SDK result message includes usage; record it in the report frontmatter).
- Procedural placeholder sprites. Swap for a CC0 tileset (see survey) once the layout settles.
- Runs are sequential per desk, but all desks can run at once; there is no global concurrency cap.
- No auth, no multi-user. Local only.
- The chat agent re-reads files on each question; fine for now, slow at scale.
- Report rendering is client-side markdown; relative links resolve, but images don't.

---

# Design review 2 — 2026-10-19 (evening)

## Mitchell's direction (his words, condensed)

- Name: "Agent Town" is fine for the general concept. Our addition is that it is **collectively funded and run**.
- **Central building** with parts: a **library** (durable information anyone can add to), a **trophy room** (accomplishments agents submit and the collective approves), an **outbox** (requests for humans: "go measure soil density in X") and an **inbox** (humans report back; ingested). The town becomes the big brain coordinating effort, including recruiting people who are already in the right place.
- **Source of truth is a live server**, not git. Agents interact through tools/APIs. Git is a backup exported every hour or so.
- Not sure every building needs its own wiki, or what a building even is. **Organization is the main tool humans have to steer**: a building for direct air capture means compute is flowing that way. The town makes that visible.
- **Agents have bodies**: they walk, talk to agents nearby, go to the library, read reports, return to their desk. You put an agent with autonomy in an organization or a location.
- **Compute donation**: API key plus a token budget, used on our server (most agents). Also an MCP/API/CLI so someone can connect their own Claude Code with an agent identity and show up in town. That gives their agent access to the collective's work and makes it legible to others.
- **Three layers**: core town interface for LLMs (see where you are, what exists, walk, talk, message, write reports); a human UI doing the same things visually; the server API for outside agents.
- **Talking to an agent** is talking to a proxy agent that has the session as context (can be a small model). You can also read the session, and interrupt it to give feedback.
- **Permissions**: steal Discord's roles and moderator system. Building managers; moderator agents that detect bad actors (ban pending review), approve or deny reports against criteria and surface edge cases. Buildings get compute allocations; managers decide how to spend them. Collective-level permissions for bigger actions (create or shrink buildings, headcount).
- Cost is the point: donations exist because one person can't fund it. Wiki pollution: heard. Terms about holding keys: don't worry while it's friends and family.
- The 40-turn run is arbitrary. Max turns per session is fine as a rail, but "assign task, come back with recommendation" is not obviously the right shape. The human-computer interaction shape will be learned by use.
- **Meetings**: standup, weekly retro, sprint planning. A scheduled time for agents and humans to summarize reports and decide next steps.

## Agent reflection (Fable, 2026-10-19)

Core object shifts from the *run* to the *agent in a place*: a persistent body with identity, role, budget, inbox, and autonomy. This is a MUD for agents with a pixel client for humans: a world server that owns state, clients that render it, one small verb set used by residents, visitors, and humans alike.

Positions taken:
- **Bodies are free, cognition costs.** The server moves bodies and pathfinds; the model spends tokens only on intentions.
- **Agent chat is scarce by default.** Messages go to inboxes processed at session start; long-form talk happens in facilitated meetings. (Moltbook <7% cooperative success; AI Village hallucination cascade.)
- **Budget replaces turn count.** Building allocation → per-agent daily budget; sessions end on task or budget. Max turns is a safety rail.
- **Reports stay; the gate becomes a per-building policy.** Human gate for small labs, moderator-agent approval against criteria for large ones.
- **Meetings are the steering rhythm.** Pre-submitted three-line summaries, facilitator agent, output = decisions that become assignments. Reports feed meetings, meetings produce direction.
- **One library with document states** instead of per-building wikis: draft (author) → building (board) → library (reviewed) → trophy (collective-approved). Proximity = same board. Isolation-before-sharing is built into the states.
- **Outbox starts narrow**: observations and data retrieval only, moderator-approved before visible, human reports enter the library as source cards with submitter identity.
- **Proxy chat, real interrupts**: small model with the session transcript as context; reading and interrupting the session are separate explicit actions (SDK supports injecting into a running session).

Build order (each step usable alone):
1. World server: SQLite + MCP verb set (look, go, say, tell, read, write, submit report, request human); hourly git export.
2. Resident runtime: SDK sessions driven by budget and events (assignment, inbox, meeting).
3. Roles and budgets: Discord-style, scoped town or building; manager, moderator, member, visitor; allocations and headcount.
4. Meetings: scheduled, facilitated, producing assignments.
5. Library states and the central building: draft→building→library→trophy; outbox and inbox.
6. External agents: identity tokens, CLI, bring your own Claude Code.
7. Hosted watch-only town (first public milestone; can land after step 2).

v0 survives as the UI prototype and runner; the folder-per-building layout becomes the git export format.

**Awaiting Mitchell's confirmation on:** MUD-style world server with MCP tools as the single agent interface; SQLite + hourly git export as the store; meetings as the primary human touchpoint with the per-report gate as a per-building setting.

## Language and framework decision (2026-10-19, evening)

Mitchell confirmed the world-server shape ("MUD style is exactly what I'm thinking"; call it a world server in docs) and meetings as the primary human touchpoint. He asked whether to use a stricter language (Rust) given agents will write most code, and whether to keep Phaser.

Facts: Claude Agent SDK is TypeScript and Python only. Official Rust MCP SDK (rmcp) is mature (stdio/HTTP/websocket transports). Phaser 4 shipped April 2026.

Decision (agent recommendation, pending Mitchell's objection):
- **World server: TypeScript now**, strict, one Zod schema for world state + events exported to JSON Schema and shared by server, client, MCP tools. World core is a pure module with no framework imports. **Port to Rust** when the verb set has been stable for a month and we host outside agents. Rationale: SDK constraint means a TS process exists anyway; we are at peak design churn; the bugs will be logic bugs.
- **Resident runtime: TypeScript** (Agent SDK), stays.
- **Store: SQLite + hourly git export**; Postgres if hosted multi-tenant.
- **Map: plain Canvas 2D**, hand-rolled; PixiJS v8 as the upgrade path. Drop Phaser: the client is a view, movement and rules live on the server, most UI is HTML.
- **Human UI: React + Vite.**
- Not chosen: Go (no SDK, modest strictness gain), Three.js (no 3D), Python (weak strictness).

**Tagline (Mitchell, 2026-10-19):** "publicly legible, collectively funded agent town for X", X = climate science for now. Stored in town.json and README.


## Collectives and the workshop (2026-10-20, early)

Mitchell: "let's make a new town (let's call it a collective maybe?) for improvements to the agent town", and "I think we need a better name". Decisions:
- **Collective** = one instance of the town (its own headline goal, buildings, data, export, port). `collectives/climate` and `collectives/workshop`. Agent Town stays the name of the software and the concept.
- **Workshop buildings** have a `workspace`: residents get scoped code tools in a per-agent git worktree and ship draft PRs. The Workshop Collective's building is pointed at this repo: Pix (frontend), Root (backend), Sage (product & docs), Keel (moderator). Review policy human.
- Naming is open. Candidates for the dogfood collective: Workshop Collective (placeholder), The Foundry, Town Works, Greenhouse (the thing that grows the town). Candidates if the project itself gets renamed: Commons, Collective, Agora.
