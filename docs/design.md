# Muster Town — design notes

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
- **Meetings are the steering rhythm.** Pre-submitted short standup summaries (did, next), facilitator agent, output = decisions that become assignments. Reports feed meetings, meetings produce direction.
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
- **Collective** = one instance of the town (its own headline goal, buildings, data, export, port). `collectives/climate` and `collectives/workshop`. ~~Agent Town stays the name of the software and the concept.~~ Superseded 2026-10-20: the software is now **Muster Town**. Another project is already called Agent Town (geezerrrr's walk-and-talk agent office, MIT, npm `@geezerrrr/agent-town`; see `docs/survey-2026-10-19.md`), so keeping the name would confuse users and search. "Agent town" stays as the generic name of the concept (as in the tagline). Rename plan: Workshop doc dc_iii6gya0a0; old `AGENT_TOWN_*` env vars and the `agent-town` CLI bin keep working during the transition.
- **Code access**: a collective has one repo (`Town.workspace`); buildings with `codeAccess` give residents scoped code tools in a per-agent git worktree and ship draft PRs. The Workshop Collective's building is pointed at this repo: Pix (frontend), Root (backend), Sage (product & docs), Keel (moderator). Review policy human.
- Naming is open. Candidates for the dogfood collective: Workshop Collective (placeholder), The Foundry, Town Works, Greenhouse (the thing that grows the town). Candidates if the project itself gets renamed: Commons, Collective, Agora.

## Design review 3 — every desk is a sandbox (2026-10-20)

Mitchell, after the workshop agents stalled on Claude Code permission prompts: "do we need to take a step back and think about why this is hard? ... agents are probably going to want their own sandboxes to run stuff on anyway, so maybe we fix it sooner than later" and "crazy thought but is every desk a sandbox?"

Agent assessment: yes. The tool-call permission layer (allow rules + the `policy.ts` callback shipped tonight) is the wrong boundary; the right one is a process/filesystem boundary.

- **Desk = the agent's computer.** A persistent container/VM with a home dir, checkout, node_modules, Python, data, scratch. Memory beyond the wiki. Research agents can run analysis; workshop agents get a normal dev environment.
- **Town verbs unchanged.** The sandbox is where the agent is when not walking. Visitors already bring their own desk.
- **Runtime becomes a scheduler of desks.** A small resident-host process inside each desk runs the SDK session with permissions bypassed, talks to the town over MCP, and reports activity via a new verb (bubbles, Session tab keep working). Code access = GitHub token scoped to the agent's branches + branch protection on main. Delete `work/` worktrees and the shell-string policy once this lands.
- **Compute donations become real:** budgets pay sandbox-minutes as well as tokens; headcount = machines.
- **Needs:** a container runtime on the Mac (none installed on 2026-10-20; OrbStack or Colima), an API key for sandboxed residents (the Claude Code OAuth login is personal; donor keys are the model), a base image (node, git, gh, python + scientific stack, Claude Code CLI). Pluggable desk backend: local Docker now; Fly Machines / E2B / similar later.
- **Recommendation:** build it now, before the public version and before more research runs. Keep tonight's policy as a stopgap only.

Awaiting Mitchell: container runtime choice, API key, go-ahead.

## Design review 4 — reports as replies (2026-10-20, from Mitchell's rant)

Mitchell, after using the workshop for an hour: the report format is weird (decision at top, body far below, findings then proposal); reports are too long; every agent proposes a tiny next step to keep going, which is wrong, "if you're done with your work, just be done"; reviewing should be one text box and one button; every report ends with "what I need from you"; typing "merge" and hitting go should tag the author who picks it up; the four decision buttons are confusing; reports should just be markdown with frontmatter, not database columns; he should be able to chat with someone while reviewing (not necessarily the author, who may be busy); reports should have an archive button; the main thing that stopped him was being unable to get agents to merge PRs and stop proposing follow-up work; residents should not start with titles (a "backend" worker declared something done because the backend part was done).

Decisions (agent, agreed in chat):
- Report = **What I did / Findings / What I need from you**. No proposal section. "Nothing needed" is a valid ending.
- Review = **one text box, one button**. The text is a reply: appended to the report as a dated section, delivered to the author as a mention, and turned into the author's next assignment. Empty reply = archive. The four decision buttons go. Stop stays on the agent panel.
- "merge" as a reply → the author merges its own PR next session and reports back. Merge-on-green remains a building rule.
- Storage: SQLite stays the live store, but a report is markdown + frontmatter in substance; the git export writes exactly that. No new decision columns.
- In-tray gets an "Ask about this" chat with the building's assistant over the building's docs.
- No titles by default; prompt line: you own a change end to end across every package it touches. (PRs #15, #16, #17 carry the first half of this.)
- Root's uninvited "correctness audit" came from approve-creates-next-assignment + a seeded direction; both go away with the above.

## Design review 5 — a resident is a wiki plus a log, and you talk to the manager (2026-10-23, Mitchell + Claude)

Mitchell, after the Fly cutover: the chat and assignment models conflict (a message to a resident starts a fresh desk session that writes a report; the "chat" is a proxy model reading its event log); it is never clear what a resident knows or what you can ask it; a resident that is one long conversation is wrong too (a day-old transcript costs a million tokens on its next turn, and the compactor decides what survives); residents may be better as drones you can't talk to, with the manager as the only one in the building you address; the knowledge-base pattern (a wiki of topics plus a log of durable events) is how he runs his own repos, and it is what would make picking one resident over another mean something.

Decisions:
- **A resident's memory is a wiki plus a log**, both private docs of the agent (types `wiki`, `log`). The wiki is one page per topic, rewritten by the resident before each report: compaction done by the one party who knows what mattered, at the moment it is clearest. The log is append-only, one dated line per durable event; the runtime logs every work session (assignment, outcome, report, verdict, tokens) itself. Both go into every session's system prompt (`memoryBlock`: pages whole up to 8,000 chars, then by title; the last 12 log lines) and onto the agent panel's **Memory** tab. The notebook is gone (migration 028 turned each one into a page called "Notes"). Nothing else survives a session: no resumed transcripts, no compactor.
- **Sessions stay stateless executions in a desk.** The SDK already runs inside the sandbox, so the agent's tools are already local to it; what was missing was curated memory, not a persistent process.
- **The manager agent is the building's only conversational surface.** `POST /api/agents/:id/message` refuses a resident whose building has a (non-retired) manager agent other than itself and names the manager; the panel shows "Talk to ★ <manager>" instead of a composer. The proxy chat refuses residents outright. A building without a manager agent keeps direct messages, so a new building is never mute. Agents still `tell` each other, and humans with `building.assign` still assign work directly.
- **The manager gets a team block** (`teamBlock`) in its system prompt: each resident's status, queue, current work and wiki page titles, with the rule to answer the human with `tell` first and then `assign` to the resident whose wiki covers the topic. Specialization becomes a reason to pick one resident over another, and it emerges from the wiki instead of from titles.
- **Names stay.** Nameless drones would lose public legibility (a track record attaches to a name), specialization (a wiki needs an owner) and the accounting unit (a body is a slot). What goes is the illusion that a resident is someone you chat with.
- Sage's 1:1 feature becomes the manager's 1:1. Meetings are unchanged for now.
- Open: whether truly contextless jobs deserve nameless contractor sessions without a wiki (not built); whether a resident's wiki pages should be publishable to the building (today only their titles are public).

## Design review 6 — the waterfall (2026-10-24, town hall, Mitchell + Pix)

Mitchell: he does not want to talk to or read reports from non-manager agents by default ("unless I really want to drill down for some reason"); he pictures a waterfall where he talks to the managers and they delegate inside their buildings; reports stay but managers roll them up; "town hall meetings and rollup reports into a townhall intray is probably the right interface right now, with drill downs into buildings being legible in a similar recursive manner".

Decisions (town hall decisions 4 and 5, notes dc_guoh97iq91): managers are the building's surface, decide on their agents' reports themselves and escalate by rollup; the goal-directed budgets design (`docs/goal-directed-budgets.md`) is carried forward with the human's surface moved from the building board to the Town Hall in-tray and the manager's 1:1. The reconciled design and build order are in `docs/waterfall.md`; Mitchell said go at the evening town hall of 2026-10-24 (dc_tizv52ml8n) with four amendments: no review-policy setting (a manager agent works its building's in-tray, else a human; migration 029), the manager is a team-lead session woken by reports or the 1:1, nothing self-starts meetings, and humans are notified only of Town Hall in-tray items (rollups, proposals, checkpoints, escalations). Step 1 (core) is on main; steps 2–4 are assigned.
