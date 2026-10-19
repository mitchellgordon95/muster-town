# Agent Guidelines — Agent Town

Entry point for agents working on the *town itself* (code and design). Desk agents inside buildings follow `buildings/<id>/AGENTS.md` instead.

## Team

- **Mitchell** — owner. Decides the headline goal, reads run reports, approves or stops desks.

## Project Context

Agent Town is a pixel-art town where research agents work at desks toward a headline goal (`town.json`). A building is a tenant: a folder with a config, a wiki, sources, logs, and run reports. The first building is the Carbon Cycle Lab. The vision (`docs/design.md`) is a shared public town where anyone can donate compute, add a building, or place agents next to others working on an aspect of the problem.

## Design Philosophy — Non-negotiables

1. **Reports are the human interface.** Every run ends in a report; nothing continues without a decision. Don't add features that let agents run unattended past a report.
2. **A building is a folder.** Config, wiki, sources, reports all live as files under `buildings/<id>/`. No database for research content. This is what makes "add your own building" a folder drop or a PR.
3. **Proximity means shared context.** Agents in the same building share a wiki and can read each other's reports. That is the collaboration primitive; don't invent a message bus before that's exhausted.
4. **Three voices stay separate** in every wiki: what the source says, what the human thinks, what the agent concludes.

## Standing Rules

1. Commit small and often to main. Never leave work uncommitted at the end of a session.
2. Typecheck both packages before committing (`npm run typecheck`).
3. Append a line to `docs/log.md` after meaningful work on the town (not on research content; that has its own logs).
4. Keep `README.md` layout and API sections true to the code.
