# Agent Town

A pixel-art town where AI research agents sit at desks and work toward a headline goal. You walk around, see what each agent is doing, read its run reports, decide whether it continues, and talk to it or to the librarian.

The first building is the **Carbon Cycle Lab**: five desks studying how CO2 moves between atmosphere, land, ocean, and people. Headline goal for the town lives in `town.json`.

## The loop

1. A desk agent does a **run**: one focused research sprint (about 40 tool calls) inside its building folder, using web search and the building's wiki.
2. Every run ends with a **report** (`buildings/<b>/reports/<desk>/run-NNN.md`): summary, findings with sources, and either a *proposal* for the next run or a *post-mortem* saying why the direction should stop.
3. The agent then sits and waits. In the town you walk up, press **E**, read the report, and click **Approve**, **Redirect** (with a note), or **Stop**.
4. Approve or Redirect starts the next run within 10 seconds. Nothing continues without a human decision.

The human reads reports, not transcripts. That is the whole point: the agents carry the research, the reports are the interface, and the human stays off the critical path without losing control.

## Run it

Requires Node 20+ and a logged-in Claude Code CLI (`claude`). The Agent SDK uses that login; no API key needed locally.

```bash
npm run install:all
npm run dev          # server on :4321, UI on http://localhost:5173
```

Or build once and serve from the API server only:

```bash
npm start            # http://localhost:4321
```

Then: arrows / WASD to walk, **E** to talk, **Esc** closes the panel. Click **Start all idle desks** in the HUD, or walk to a desk and start it from its Report tab.

## Layout

```
town.json                     headline goal for the whole town
buildings/<id>/               one building = one research group (a tenant)
  building.json               name, goal, desks (persona, direction), librarian
  AGENTS.md                   standing rules the desk agents follow
  wiki/main.md                master article, open problems = the to-do list
  wiki/desks/<desk>.md        one running article per desk
  sources/                    one source card per external source
  reports/<desk>/run-NNN.md   run reports with frontmatter (verdict, decision, note)
  log/                        weekly append-only logs
server/                       Node + Claude Agent SDK: runners, reports API, chat, websocket
town/                         Vite + Phaser frontend
docs/                         design notes and the survey of prior art
```

A building is just a folder. Adding a building = adding a folder with a `building.json` and an `AGENTS.md`; the server picks it up on the next poll and the town draws it.

## API

- `GET /api/town` town, buildings, desks with live status
- `GET /api/reports/:b/:d` all reports for a desk
- `POST /api/reports/:b/:d/:run/decision` `{decision: approve|redirect|stop, note}`
- `POST /api/desks/:b/:d/start` `{note?}` first run or restart
- `POST /api/desks/:b/start-all`
- `POST /api/chat` `{building, agent, message, sessionId?}` talk to a desk agent or the librarian (read-only tools)
- `GET /api/file/:b/<path>` read any file in a building
- `WS /ws` `state` and `activity` events

## Status

v0, built 2026-10-19. Single-user, local. See `docs/design.md` for where this goes (shared public town, bring-your-own agents and compute).
