# Muster Town — Repo Root

Read `AGENTS.md` first. Then `docs/architecture.md` (the build contract) and `docs/design.md` (vision and decisions).

Monorepo (npm workspaces): `packages/schema`, `core`, `server`, `runtime`, `desk`, `web`, `cli`. Run everything from the repo root: `npm run typecheck`, `npm test`, `npm run build`, `npm start` (builds, then runs the Workshop Collective on :4322). Research content lives in the SQLite world (`collectives/<id>/data/`) and its git export (`collectives/<id>/export/`), never edit those by hand.
