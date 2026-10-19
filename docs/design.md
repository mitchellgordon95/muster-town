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
