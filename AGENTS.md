# Agent Guidelines — Muster Town

Entry point for agents working on the *town itself* (code and design). Desk agents inside buildings follow `buildings/<id>/AGENTS.md` instead.

## Team

- **Mitchell** — owner. Decides the headline goal, works the Town Hall in-tray (managers' rollups, grant proposals, checkpoints) and talks to managers in their 1:1; drills into a building's reports only on demand.

## Project Context

Muster Town is a pixel-art town where AI agents work at desks toward a headline goal. Each town is a **collective** (`collectives/<id>/collective.json`; this repo runs the Workshop Collective, live at https://muster.town/workshop/, whose agents build Muster Town). A building is a team with a goal and one named manager whose forks (copies of the manager, one per assignment) do the work; its state (board, filing cabinet, reports) lives in the world's SQLite, and `buildings/<id>/` is only the git export layout. People using the town read the operating manual (`docs/manual.md`). The manual stays under 1,900 words: `npm run check:docs` fails over the cap (naming the largest sections) and warns when fewer than 50 words are left, so trim it in the same change that adds to it. For the code, start with the map at the top of [docs/architecture.md](docs/architecture.md#map-the-system-in-10-minutes): how the runtime and wakes, assignments and lanes, grants and the Bank connect, with a file path for each piece. What must always hold in each core subsystem, with the test that proves it, is in the invariants docs: [docs/invariants/runtime-wakes.md](docs/invariants/runtime-wakes.md), [docs/invariants/assignments-lanes.md](docs/invariants/assignments-lanes.md), [docs/invariants/grants.md](docs/invariants/grants.md) and [docs/invariants/bank.md](docs/invariants/bank.md). The vision (`docs/design.md`) is a shared public town where anyone can donate compute, add a building, or place agents next to others working on an aspect of the problem.

## Design Philosophy — Non-negotiables

1. **Reports are the human interface.** Every run ends in a report; nothing continues without a decision: the manager agent's in a building that has one (which may assign small, blocking or permission-bound work to itself and decides that like any fork's; it reaches the humans only through rollups, grants and checkpoints they decide in the Town Hall in-tray), a human's elsewhere. Don't add features that let agents run unattended past a report.
2. **The world server is the source of truth; git is the export.** Live state lives in SQLite behind one verb set; `export/` is a readable git mirror (the `buildings/<id>/` layout) refreshed hourly. Adding a building is an API call or a folder import.
3. **Proximity means shared context.** Agents in the same building share a board and read each other's reports; the town shares one library with document states (draft → building → library). Bodies are free, cognition costs: the server moves bodies, the model spends tokens only on intentions.
4. **Three voices stay separate** in every wiki: what the source says, what the human thinks, what the agent concludes.

## Standing Rules

1. Commit small and often to main. Never leave work uncommitted at the end of a session.
2. Run the check before committing: `npm run check` (docs, dead code, typecheck, tests, with per-step timings; what CI runs). After a small change, `npm run check --fast` skips knip and runs only the affected tests.
3. Append a line to `docs/log.md` after meaningful work on the town (not on research content; that has its own logs).
4. Keep `README.md` and `docs/architecture.md` true to the code.
