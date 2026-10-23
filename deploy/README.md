# Deploying Muster Town to muster.town

**Prod runs on Fly.io** (since 2026-10-22): the town is one always-on Machine in the `muster-town` app, and resident desks are
Machines in the `muster-desks` app (below). The older single-VPS procedure further down (OVH box, systemd, Caddy) is kept as an
alternative; that box was deleted.

## Prod on Fly.io
- **The town:** app `muster-town`, one Machine (`shared-cpu-2x`, 2 GB, region `iad`) with a 10 GB volume `town_data` at `/data`.
  SQLite is a single writer, so never more than one Machine (`fly deploy --ha=false`). There is no Postgres. Fly takes daily volume snapshots (5 kept).
- **What's on the volume:** `/data/repo` is the live checkout (code, `collectives/workshop/data` with `town.db`, `export/`). The image
  (`deploy/fly/Dockerfile`) is only the runtime plus a baked copy of the checkout for the first boot. `deploy/fly/entrypoint.sh` is the supervisor:
  it restarts the server when it exits 75, so the town's own `redeploy` (git pull, install, build, drain) keeps working unchanged.
- **Config:** `fly.town.toml` (env, volume, health check). Desk backend and callback URL come from `MUSTER_TOWN_DESKS` (JSON) in its `[env]`,
  so the Mac's dev `collective.json` keeps docker desks. Secrets are Fly secrets (`fly secrets list -a muster-town`): `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `GITHUB_CLIENT_ID/SECRET`, `AGENT_TOWN_ADMINS`, `MUSTER_TOWN_DATA_KEY`, `FLY_API_TOKEN` (the desks app's deploy token),
  `DESK_ENV_MINICLAW_*` (until the Town Hall Secrets tab replaces them), and `GH_TOKEN` (a fine-grained token: clones/pulls and desk pushes).
- **Rebuild the image:** `deploy/fly/build.sh` (a throwaway clone of GitHub main with the build-context fixes Fly needs; see the script). It does
  not touch the live checkout: take a new image's code by deleting `/data/repo` (`fly ssh console -a muster-town -C "rm -rf /data/repo"`) and
  restarting the Machine, or ship code with the town's `redeploy` as usual.
- **Migrate a town in:** stop the old server, `PRAGMA wal_checkpoint(TRUNCATE)`, `tar -czf RESTORE.tgz -C collectives/workshop data export`,
  `fly ssh sftp put RESTORE.tgz /data/RESTORE.tgz -a muster-town`, `fly machine restart <id> -a muster-town`. The entrypoint unpacks it
  (and keeps it as `RESTORE.done-*.tgz`). Done for the Workshop on 2026-10-22.
- **Domain:** `A`/`AAAA` for `muster.town` point at the app's Fly IPs (`fly ips list -a muster-town`), `www` is a CNAME to the apex;
  certs via `fly certs add` (Let's Encrypt, auto-renewed).
- **Logs:** `fly logs -a muster-town`. Shell: `fly ssh console -a muster-town`.
- **GitHub sign-in:** the OAuth app's callback URL must include `https://muster.town/auth/github/callback`.
- **Cost (estimate):** town Machine about $13/mo (24/7) + volume $1.50 + desk Machines per use; compare the old single-box plan in dc_gxtv36rbu6.

### Prod open items (as of 2026-10-22)
- **Blocking code agents:** `GH_TOKEN` is not set on the town app, so desks can't clone the private repo and the town can't pull for `redeploy`.
  Needs a fine-grained token for this repo only (Contents + Pull requests, read/write): `fly secrets set GH_TOKEN=... -a muster-town`.
- **GitHub sign-in on prod:** add `https://muster.town/auth/github/callback` to the OAuth app (client id is in the Fly secrets), or create a second app for prod.
- **Backups:** only Fly's daily volume snapshots (5 kept). No off-site copy yet (Litestream to object storage, or a nightly `sqlite3 .backup` pushed out).
- **Secrets:** `DESK_ENV_MINICLAW_*` are Fly secrets that reach every desk; move them to the Town Hall Secrets tab with grants and drop the env fallback.
  The admin and agent tokens in the migrated database were issued on the Mac: rotate them (docs/secrets.md, Dara's design dc_ios62uyco3 §3f).
- **Deploys:** prod follows `main` directly (`MUSTER_TOWN_DEPLOY_BRANCH=main`); there is no CI gate or `prod` branch yet (`deploy/ci.yml` is not active).
- **One Machine** means a restart is a short outage; the volume is the only copy of the live world.
- **Cold start:** a brand-new desk on a fresh Fly host pulls the ~1 GB desk image (about 90 s once); resuming a stopped desk takes about 1 s.
- **Dev on the Mac:** don't start `collectives/workshop` there (it would fork the world); Fly desks from a Mac town need a public tunnel, so dev uses docker desks.

## Single-VPS deployment (legacy; the OVH box is gone)
Plan and reasoning: town docs dc_mltonxkizi (deploy + CI) and dc_vxgg8r55ha (stress test: 6 desks at once).

| file | what |
|---|---|
| `muster-town.service` | systemd unit (replaces `scripts/serve.sh` on Linux): `Restart=always`, so the redeploy's exit 75 and crashes both restart it. Pulls `prod`, not `main` (`MUSTER_TOWN_DEPLOY_BRANCH`). |
| `Caddyfile` | TLS for muster.town (automatic Let's Encrypt), `reverse_proxy 127.0.0.1:4322` (REST, /mcp, /ws, web); www redirects. |
| `bootstrap.sh` | idempotent box setup, run as root: 4 GB swap, node 22, Caddy, gh, the `muster` user, the deploy key and clone in `/srv/muster-town`, deps + web + desk image, the ufw rule letting desks reach port 4322 over `docker0`, `/etc/muster-town/env`, a nightly sqlite backup, the unit and Caddy. |
| `cutover.sh` | box side of the cutover: swap in the Mac's `town.db` (keeps the old one), restart, set `maxRunning` 6 again. |
| `ci.yml` | **not active yet**: Mitchell moves it to `.github/workflows/ci.yml` (agents can't push workflows). Typecheck + tests + web build on PRs and main; green main moves `prod` (fast-forward) and POSTs `/api/admin/redeploy`. |

## First deploy
1. `scp -r deploy ubuntu@15.204.79.179:` then `sudo bash deploy/bootstrap.sh`. The first run stops and prints a public
   key: add it as a **read-only deploy key** on the repo (Settings → Deploy keys), then run it again.
2. Until CI has created the `prod` branch the checkout stays on `main`: set `MUSTER_TOWN_DEPLOY_BRANCH=main` in
   `/etc/muster-town/env` meanwhile (or push `main:prod` once by hand).
3. Mitchell fills `/etc/muster-town/env` over SSH (never through an agent): `CLAUDE_CODE_OAUTH_TOKEN`,
   `MUSTER_TOWN_DATA_KEY` (`openssl rand -base64 32`; it encrypts the collective secrets in the DB, so a `town.db`
   copied from another host needs that host's key, or set its secrets again), and later
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`MUSTER_TOWN_SESSION_SECRET`. Then `sudo systemctl restart muster-town`.
   **No `DESK_ENV_*` here** (they reach every desk): tool credentials like `MINICLAW_WS_TOKEN` go in the Town Hall's
   Secrets tab with a grant (docs/secrets.md).
4. Desks get `GH_TOKEN` from `gh auth token` (collective `desks.ghToken` default `gh-cli`): log the `muster` user in
   with a **fine-grained PAT** for this repo only (contents + pull requests):
   `sudo -u muster -H gh auth login --with-token < pat.txt`.
5. Cap work sessions at **6** (live setting, kept in the database; redo it after copying in a `town.db`):
   `curl -X PUT http://127.0.0.1:4322/api/town/desks -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"maxRunning":6}'`
   (`$ADMIN`: `sudo cat <data dir>/admin-token`; the server logs only its path).
6. Check: `curl https://muster.town/api/health` shows the commit; a resident's work session reaches `/mcp`.

## Cutover (the Mac's Workshop town moves to the box)
Do this after the smoke test, with the Mac's world as the one source of truth from then on.
1. Mac: stop the town (Ctrl-C `scripts/serve.sh`), then
   `sqlite3 collectives/workshop/data/town.db ".backup /tmp/town.db"` and `scp /tmp/town.db ubuntu@15.204.79.179:/tmp/`.
2. Box: `sudo bash deploy/cutover.sh /tmp/town.db`. It checks the file, keeps prod's old world in
   `/var/backups/muster-town/pre-cutover-*.db`, swaps the db in, restarts, and sets `maxRunning` back to 6. Then
   `shred -u /tmp/town.db` on both machines.
3. Rotate what came along in the db: the admin token and every agent token were issued on the Mac
   (Dara's design dc_ios62uyco3 §3f). Donated keys stay as they are.
4. Not copied: desk home volumes (`deskhome-<agentId>` on the Mac's Docker). Residents get fresh desks and re-clone;
   their notebooks and docs live in the db. If one needs files back:
   `docker run --rm -v deskhome-<id>:/v alpine tar -C /v -cz . > home.tgz` on the Mac, and the reverse on the box.
5. From then on the Mac is dev only: don't start `collectives/workshop` there again (it would fork the world).

## Every deploy after that
Merge to main → CI green → `prod` moves → redeploy (pull `prod`, rebuild, drain, exit 75, systemd restarts).
CI's redeploy needs the Actions secret `MUSTER_TOWN_DEPLOY_TOKEN` (a token of an agent with the town `deployer`
role); without it CI only moves `prod`, and the `redeploy` tool or the planning desk button ships it.
Rollback: `git revert` on main. Emergency: point `prod` at the last good sha and redeploy.

## Logs and backups
`journalctl -u muster-town -f`, `journalctl -u caddy`. Nightly `sqlite3 .backup` to `/var/backups/muster-town/`
(14 days). Restore: stop the service, copy a backup over `collectives/workshop/data/town.db`, start it.

## Desks on Fly.io Machines (`desks.backend: "fly"`)
Open internet out, per-second billing, no prepayment. Code: `packages/runtime/src/desk/fly.ts` (`FlyApi`, behind the provider-neutral `SandboxBackend`).
- **Setup (once):** `fly apps create muster-desks`; `fly tokens create deploy -a muster-desks -x 8760h`; put `FLY_API_TOKEN=<token>` and
  `FLY_APP=muster-desks` in the collective's `.env` (host secrets, never `DESK_ENV_*`). Build and push the desk image to Fly's registry
  (`fly deploy --build-only --push --image-label desk -c fly.desk.toml`, run with `FLY_ACCESS_TOKEN` set to that token; Fly's remote builder is amd64).
- **Config:** `"desks": { "backend": "fly", "townUrl": "https://<where the town is reachable from the internet>", "maxRunning": 6 }`.
  Optional: `snapshot` (an image ref; default `registry.fly.io/$FLY_APP:desk`), `region` (default `iad`), `cpuKind` (`shared`|`performance`), `cpus`, `memoryMb`.
- **Model:** one Machine per agent (`desk-<collective>-<agent>`) with a 5 GB volume mounted at `/home/agent`. A Machine stops after the session
  (and by itself after 6 h at the latest); a stopped one costs only its root disk, and its volume persists. A session is started in the background
  on the Machine and followed with short polling execs, because Fly drops a single exec call after about a minute.
- **Verified live (2026-10-22):** create from the image (~25 s, includes the volume), runs as `agent` with `HOME=/home/agent`, secrets with quotes arrive intact,
  outbound internet works, an 80 s run is followed past the exec limit, stop/start keeps the volume. Re-check with
  `node --env-file=collectives/workshop/.env --import tsx scripts/fly-desk-check.ts` (a few cents).
- **Not yet checked:** a full agent session on it (needs the town reachable from Fly: a tunnel for the Mac, the real host later), the shared-vs-performance CPU
  choice under `npm install` + tests, and what happens when a volume's host has no capacity.
