# Deploying Muster Town to muster.town

**Prod runs on Fly.io** (since 2026-10-22): the town is one always-on Machine in the `muster-town` app, and resident desks are
Machines in the `muster-desks` app (below). The older single-VPS procedure further down (OVH box, systemd, Caddy) is kept as an
alternative; that box was deleted.

## Prod on Fly.io
- **The town:** app `muster-town`, one Machine (`shared-cpu-2x`, 2 GB, region `iad`) with a 10 GB volume `town_data` at `/data`.
  SQLite is a single writer, so never more than one Machine (`fly deploy --ha=false`). There is no Postgres. Fly takes daily volume snapshots (5 kept).
- **What's on the volume:** `/data/repo` is the live checkout (code only) and `/data/workshop/{data,export}` is the town's state (`town.db`,
  `admin-token`, `session-secret`, the export mirror), set by `MUSTER_TOWN_DATA`/`MUSTER_TOWN_EXPORT` in `fly.town.toml`. The state is deliberately
  outside the checkout so nothing done to `/data/repo` can touch it (the entrypoint moves it out once on a town deployed before this split).
  The image (`deploy/fly/Dockerfile`) is only the runtime plus a baked copy of the checkout for the first boot. `deploy/fly/entrypoint.sh` is the
  supervisor: it restarts the server when it exits 75, so the town's own `redeploy` (git pull, install, build, drain) keeps working unchanged.
- **Config:** `fly.town.toml` (env, volume, health check). Desk backend and callback URL come from `MUSTER_TOWN_DESKS` (JSON) in its `[env]`,
  so the Mac's dev `collective.json` keeps docker desks; `maxRunning` is not in it (a live setting, kept in the database). Secrets are Fly secrets
  (`fly secrets list -a muster-town`): `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_CLIENT_ID/SECRET`, `AGENT_TOWN_ADMINS`,
  `MUSTER_TOWN_DATA_KEY`, `FLY_API_TOKEN` (the desks app's deploy token). No `DESK_ENV_*`: the runtime dropped that fallback on 2026-10-25;
  tool credentials for desks are Town Hall secrets with grants (docs/secrets.md).
- **The repo token:** a collective secret named `GH_TOKEN` at the Town Hall (planning desk, Secrets tab): a fine-grained token for the collective's repo with
  Contents and Pull requests read/write. Desks with code access clone and push with it and `redeploy` pulls with it (docs/secrets.md). A host
  `GH_TOKEN` Fly secret still works as the fallback (`desks.ghToken: "env"`), but it belongs to the collective, not the host.
- **Rebuild the image:** `deploy/fly/build.sh` (a throwaway clone of GitHub main with the build-context fixes Fly needs; see the script). A plain
  `fly deploy` fails on purpose (the Dockerfile wants `.git` shipped as `gitdir` and a clean tree). The build does not touch the live checkout:
  ship code with the town's `redeploy`. To reset the checkout itself to the image's, `fly ssh console -a muster-town -C "rm -rf /data/repo"` and
  restart the Machine: with the state at `/data/workshop` that loses only the checkout and its `node_modules`.
- **CI and redeploy:** `.github/workflows/ci.yml` runs typecheck, tests and the web build on every PR and every push to `main`. A green `main`
  commit is fast-forwarded to the `prod` branch and the workflow POSTs `/api/admin/redeploy` as the "CI" visitor (an agent with the town
  `deployer` role and no inherited permissions; its token is the Actions secret `MUSTER_TOWN_DEPLOY_TOKEN`). The town's redeploy then does what
  it always did (pull, install if the lockfile changed, build, drain up to 30 min, pull again, exit 75; see the drain policy below), but it pulls `prod`
  (`MUSTER_TOWN_DEPLOY_BRANCH` in fly.town.toml), so a red commit on `main` never goes live. Residents of the Workshop push to `main` as before;
  nobody waits on a PR review; what they can't do is take the town down with a commit that fails its own tests. The `redeploy` verb and the
  planning desk button still work (they also pull `prod`), for a redeploy without a new commit. Rollback: `git revert` on main and let CI
  ship it; emergency: point `prod` at the last good sha and redeploy. A red run leaves the live town where it was and shows in the Actions tab.
- **Drain policy:** the drain holds new work sessions and waits up to 30 min for running *work* sessions (a restart would orphan
  them; at startup the orphans are stopped and their assignments re-queued). A *meeting* session (a facilitation, or the manager answering a 1:1)
  holds it only 2 min (`drainMeetingMs`): a human can talk for an hour, so the deploy does not block on a meeting. Instead: post the notice,
  restart, resume. Just before the exit every open meeting gets a "Town" line ("Pix's reply is waiting on a redeploy (commit …); … resumes after
  the restart"), and after the restart the manager's session is woken for each open 1:1 with the lines it missed, and standups are
  re-facilitated from their transcript. Details: docs/meetings.md §6.
- **Migrate a town in:** stop the old server, `PRAGMA wal_checkpoint(TRUNCATE)`, `tar -czf RESTORE.tgz -C collectives/workshop data export`,
  `fly ssh sftp put RESTORE.tgz /data/RESTORE.tgz -a muster-town`, `fly machine restart <id> -a muster-town`. The entrypoint unpacks it into a
  scratch dir, checks `data/town.db` is in it, then swaps it in; the state it replaces stays at `/data/workshop/*.replaced-<stamp>` and the tarball
  as `RESTORE.done-*.tgz` (an unusable tarball becomes `RESTORE.bad-*.tgz` and nothing changes). Done for the Workshop on 2026-10-22.
- **Domain:** `A`/`AAAA` for `muster.town` point at the app's Fly IPs (`fly ips list -a muster-town`), `www` is a CNAME to the apex;
  certs via `fly certs add` (Let's Encrypt, auto-renewed).
- **Logs:** `fly logs -a muster-town`. Shell: `fly ssh console -a muster-town`.
- **GitHub sign-in:** the OAuth app's callback URL must include `https://muster.town/auth/github/callback`.
- **Cost (estimate):** town Machine about $13/mo (24/7) + volume $1.50 + desk Machines per use; compare the old single-box plan in dc_gxtv36rbu6.

### Throwaway for load tests (grant gr_wqnunw5yd8)
Load never goes to muster.town. `deploy/fly/throwaway.sh` (needs `FLY_STRESS_TOKEN`, the Fly token Mitchell made for it, and `GH_TOKEN` to clone
the private repo) creates the app `muster-town-stress`: the same Dockerfile built from GitHub main, the same size and region as `fly.town.toml`,
a 10 GB volume, a fresh random `MUSTER_TOWN_DATA_KEY` as its only secret (no Claude token, no GitHub OAuth, no repo token, no `FLY_API_TOKEN`:
it can neither start desks nor spend tokens; `MUSTER_TOWN_DESKS` points at a docker backend the Machine does not have, so a session start fails
at once). `throwaway.sh admin-token` fetches its admin token over `fly ssh` into `~/.muster-stress/admin-token`; `throwaway.sh destroy` deletes
the app with its volume. The harness: `scripts/stress/viewers.mjs` (WebSocket viewers ramped 10 → 400 while scripted bodies walk and talk) and
`scripts/stress/agents.mjs` (scripted visitors ramped 5 → 80 over `/mcp`), both refusing a `muster.town` target, both writing one row per ramp
step to `~/.muster-stress/results/`. `GET /api/health` on any town reports `load: {lagMs, rssMb, wsClients}` (read-only) for the same numbers.

### Prod open items (as of 2026-10-25)
Done (Mitchell, 2026-10-25, after rollup dc_jkbed7u3fo): the old OVH box is deleted (`15.204.79.179` now answers SSH with a different ed25519
host key than the one recorded at creation, dc_qy9d36q84o, so the IP was reassigned), the leftover host `GH_TOKEN` and `DESK_ENV_MINICLAW_*`
Fly secrets are unset (not checkable from a desk; the Town Hall values win either way), and `https://muster.town/auth/github/callback` is on the
OAuth app (GitHub accepts the authorize URL `/auth/github` redirects to, checked 2026-10-25). The runtime's `DESK_ENV_` fallback is gone since
the same day. Still open:
- **Repo token:** the collective secret `GH_TOKEN` at the Town Hall (set 2026-10-23 18:54 UTC) is the only one; verified end to end from a Fly desk
  on 2026-10-24 (clone, `gh auth status`, `git ls-remote`, `git push --dry-run`).

### Backups (off-site, grant gr_jkorz4f49a)
- **What:** the server copies `town.db` off the volume every night at **04:17 UTC**, plus once at boot when the last copy is older than 24 h
  (`packages/server/src/backup/`): `db.backup()` to `/data/workshop/backups/town-<date>.db` (SQLite's online backup API, WAL-safe), sealed to one
  file and `integrity_check`ed, gzipped, encrypted (AES-256-GCM, iv[12] | tag[16] | ciphertext, AAD `muster-town backup v1`) and PUT as
  `town/<YYYY-MM-DD>.db.gz.enc`, signed with a small SigV4 signer (no SDK). A failure is logged and kept as `backup.error`; it never stops the server.
- **Destination:** the Tigris bucket `fly storage create -a muster-town` makes for the muster-town app (same Fly bill, free tier at this size,
  replicated object storage off the volume's host). It sets the bucket credentials on the app itself: `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (path-style, region `auto`). List or download objects with the Tigris dashboard
  (`fly storage dashboard <bucket>`) or `scripts/backup/restore-helper.mjs list|get` with those four in the environment.
- **Key custody:** `MUSTER_TOWN_BACKUP_KEY` (32 bytes, `openssl rand -base64 32`) is generated by **Mitchell**, kept in his password manager as
  "muster-town backup key" and set with `fly secrets set MUSTER_TOWN_BACKUP_KEY=... -a muster-town` (docs/secrets.md "The backup key"). It is not the
  data key, never in the DB, never on health, never on a desk. Losing it makes every object unreadable; a leaked object without it is noise.
- **Retention:** the newest **30 daily objects** in the bucket (older ones deleted after each run) and the **last local copy**
  `/data/workshop/backups/town-<date>.db` on the volume (older local copies deleted). Fly's daily volume snapshots (5 kept) stay as the on-host copy.
- **Health:** `GET https://muster.town/api/health` shows `backup: {lastAt, bytes, dest, error}` (read-only; never the key or credentials), or
  `backup: null` while any of the five env vars is missing: the job is then off, with one boot warning naming them. `lastAt` older than 24 h or a
  non-null `error` means last night's copy did not land.
- **Restore** (`scripts/backup/restore.sh`, with `scripts/backup/restore-helper.mjs` reusing the server's own cipher and signer; node >= 22.6, no npm install):
  ```sh
  # the five secrets in the environment: the four AWS_*/BUCKET_NAME values from `fly storage` (or `fly ssh console -a muster-town -C env`)
  # and MUSTER_TOWN_BACKUP_KEY from the password manager; FLY_API_TOKEN able to create/destroy the scratch app; GH_TOKEN (repo read)
  scripts/backup/restore.sh --local latest                 # download, decrypt, gunzip, integrity_check, agent count + newest doc; no Fly
  scripts/backup/restore.sh latest                         # ...then boot the scratch app muster-town-restore (shared-cpu-1x, 1 GB volume, iad)
                                                           # from RESTORE.tgz (data/town.db only; fly ssh sftp put + restart), compare the
                                                           # scratch town's /api/town agent count and newest doc with the copy's, destroy it
  scripts/backup/restore.sh town/2026-10-27.db.gz.enc      # one named object; --keep leaves the scratch app up, --destroy removes it later
  scripts/backup/restore.sh --local ~/Downloads/2026-10-27.db.gz.enc   # a file fetched by hand (needs only the key)
  ```
  The decrypted copy (`~/.muster-restore/<stamp>/data/town.db`) and the scratch town hold every token of the live town in plaintext (`tokens`
  table): delete the directory and destroy the scratch app when done (the script does the latter unless `--keep`). The scratch app gets a
  fresh random `MUSTER_TOWN_DATA_KEY` and none of the live secrets, so the restored collective secrets are unreadable there and it can neither
  spend tokens nor push to GitHub nor start desks. **Restoring onto muster-town itself** is the "Migrate a town in" path above with this
  `RESTORE.tgz`: stop nothing (the entrypoint swaps the state at the next restart and keeps the replaced state beside it).
- **Drill:** _not run yet (grant step 4): fill in the date, the object restored, the scratch app, the agent count and newest doc on the copy vs
  the scratch town vs the live town at backup time, and that the app was destroyed._
- **Token rotation:** the admin and agent tokens in the migrated database were issued on the Mac: rotate them (docs/secrets.md, Dara's design dc_ios62uyco3 §3f).
- **Deploys:** gated by CI since 2026-10-23 (see "CI and redeploy" above). Branch protection on `main` is not on: pushing to main is still allowed and expected.
- **One Machine** means a restart is a short outage; the volume is the only copy of the live world.
- **Session events** from Fly desks are labelled `backend: "docker"` (the session `backend` field has only `host`/`docker`): cosmetic, but wrong.
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
| (CI) | lives at `.github/workflows/ci.yml` since 2026-10-23 (it sat here as `deploy/ci.yml` while agent tokens lacked the `workflow` scope). |

## First deploy
1. `scp -r deploy ubuntu@15.204.79.179:` then `sudo bash deploy/bootstrap.sh`. The first run stops and prints a public
   key: add it as a **read-only deploy key** on the repo (Settings → Deploy keys), then run it again.
2. Until CI has created the `prod` branch the checkout stays on `main`: set `MUSTER_TOWN_DEPLOY_BRANCH=main` in
   `/etc/muster-town/env` meanwhile (or push `main:prod` once by hand).
3. Mitchell fills `/etc/muster-town/env` over SSH (never through an agent): `CLAUDE_CODE_OAUTH_TOKEN`,
   `MUSTER_TOWN_DATA_KEY` (`openssl rand -base64 32`; it encrypts the collective secrets in the DB, so a `town.db`
   copied from another host needs that host's key, or set its secrets again), and later
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`MUSTER_TOWN_SESSION_SECRET`. Then `sudo systemctl restart muster-town`.
   **No `DESK_ENV_*` here** (they reach every desk): tool credentials like `MINICLAW_WS_TOKEN` go in the planning desk's
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
Push to main → CI green → `prod` moves → redeploy (pull `prod`, rebuild, drain, exit 75, the supervisor restarts).
CI's redeploy uses the Actions secret `MUSTER_TOWN_DEPLOY_TOKEN` (the "CI" visitor's token, deployer role);
without it CI only moves `prod`, and the `redeploy` tool or the planning desk button ships it.
Rollback: `git revert` on main. Emergency: point `prod` at the last good sha and redeploy.

## Logs and backups (legacy: the OVH box is gone)
`journalctl -u muster-town -f`, `journalctl -u caddy`. The box kept a nightly `sqlite3 .backup` in `/var/backups/muster-town/` (14 days), local
only; restore was: stop the service, copy a backup over `collectives/workshop/data/town.db`, start it. On Fly the server itself ships an
encrypted copy off the volume every night and the restore goes through `RESTORE.tgz`: see "Backups (off-site, grant gr_jkorz4f49a)" above.

## Desks on Fly.io Machines (`desks.backend: "fly"`)
Open internet out, per-second billing, no prepayment. Code: `packages/runtime/src/desk/fly.ts` (`FlyApi`, behind the provider-neutral `SandboxBackend`).
- **Setup (once):** `fly apps create muster-desks`; `fly tokens create deploy -a muster-desks -x 8760h`; put `FLY_API_TOKEN=<token>` and
  `FLY_APP=muster-desks` in the collective's `.env` (host secrets, never `DESK_ENV_*`). Build and push the desk image to Fly's registry
  (`fly deploy --build-only --push --image-label desk -c fly.desk.toml`, run with `FLY_ACCESS_TOKEN` set to that token; Fly's remote builder is amd64).
- **New desk image:** the town does it itself when the host has the secret `FLY_DESKS_ACCESS_TOKEN` (a muster-desks deploy token; on prod `fly secrets set ... -a muster-town`, set 2026-10-26):
  `redeploy` with the desk image (planning desk "also rebuild desk image", or the `redeploy` tool with `image: true`) runs `scripts/fly-desk-image.sh`
  (installs flyctl into `/data/flyctl` if missing, then `fly deploy --build-only --push --remote-only --image-label desk -c fly.desk.toml`), and after the drain
  destroys every idle resident's desk Machine (`DELETE /machines/<id>?force=true`; the `deskhome-*` volumes stay), so the next session creates it from the new `:desk`.
  By hand: `FLY_ACCESS_TOKEN=<token> bash scripts/fly-desk-image.sh`, then `fly machine destroy --force <id>` per desk-* Machine (never `fly volumes destroy`):
  starting a stopped Machine keeps its old image.
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
