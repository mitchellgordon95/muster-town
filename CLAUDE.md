# Muster Town — Repo Root

Read `AGENTS.md` first. Then `docs/architecture.md` (the build contract) and `docs/design.md` (vision and decisions).

Monorepo (npm workspaces): `packages/schema`, `core`, `server`, `runtime`, `web`, `cli`. Run everything from the repo root: `npm run typecheck`, `npm test`, `npm run build`, `npm start`. Research content lives in the SQLite world (`data/`) and its git export (`export/`), never edit those by hand.
