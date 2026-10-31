# Deploying Muster Town to muster.town

**Prod runs on Fly.io** (since 2026-10-22): the town is one always-on Machine in the `muster-town` app, and resident desks are
Machines in the `muster-desks` app (below). The older single-VPS procedure further down (OVH box, systemd, Caddy) is kept as an
alternative; that box was deleted.

## Prod on Fly.io
- **The town:** app `muster-town`, one Machine (`performance-1x`, 2 GB, region `iad`; shared-cpu-2x throttled to ~12 % of a core on 2026-10-31 and 503ed) with a 10 GB volume `town_data` at `/data`.
  SQLite is a single writer, so never more than one Machine (`fly deploy --ha=false`). There is no Postgres. Fly takes daily volume snapshots (5 kept).
- **What's on the volume:** `/data/repo` is the live checkout (code only) and `/data/workshop/{data,export}` is the town's state (`town.db`,
  `admin-token`, `session-secret`, the export mirror), set by `MUSTER_TOWN_DATA`/`MUSTER_TOWN_EXPORT` in `fly.town.toml`. The state is deliberately
  outside the checkout so nothing done to `/data/repo` can touch it (the entrypoint moves it out once on a town deployed before this split).
  The image (`deploy/fly/Dockerfile`) is only the runtime plus a baked copy of the checkout for the first boot. `deploy/fly/entrypoint.sh` is the
  supervisor: it restarts the server when it exits 75, so the town's own `redeploy` (git pull, install, build, drain) keeps working unchanged.
  On every boot it sets `origin` to `MUSTER_TOWN_REPO` (default `https://github.com/mitchellgordon95/muster-town.git`, what muster.town uses;
  a town built from a fork sets its fork's URL in `[env]`).
- **Config:** `fly.town.toml` (env, volume, health check). Desk backend and callback URL come from `MUSTER_TOWN_DESKS` (JSON) in its `[env]`,
  so the Mac's dev `collective.json` keeps docker desks; `maxRunning` is not in it (a live setting kept in the database, default 30: Planning → System → Session slots, or `PUT /api/town/desks {"maxRunning":N}`; a stored value is kept). Secrets are Fly secrets
  (`fly secrets list -a muster-town`): `GITHUB_CLIENT_ID/SECRET`, `AGENT_TOWN_ADMINS`, no model credential (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the env stops the boot: the subscription token and API keys are Bank inputs added at the Town Hall, see docs/postmortem-2026-10-30-api-key-leak.md),
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
  (`MUSTER_TOWN_DEPLOY_BRANCH` in fly.town.toml), so a red commit on `main` never goes live. The Workshop's manager and its forks push to `main` as before;
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

### Backups (off-site, grants gr_jkorz4f49a, gr_ba0juhlm7n)
- **What:** the server copies `town.db` off the volume **every hour on the hour (UTC)**, plus once at boot (after 30 s) when the last copy is older
  than 1 h (`packages/server/src/backup/`): `db.backup()` to `/data/workshop/backups/town-<date>T<HH>.db` (SQLite's online backup API, WAL-safe),
  sealed to one file and `integrity_check`ed, gzipped, encrypted (AES-256-GCM, iv[12] | tag[16] | ciphertext, AAD `muster-town backup v1`) and PUT
  as `town/<YYYY-MM-DD>T<HH>.db.gz.enc`, signed with a small SigV4 signer (no SDK). Worst case, a dead volume loses about 1 h of town state.
  The whole run (copy, checks, streamed gzip, encrypt, upload, verify, prune) runs in a `worker_threads` worker (`worker.ts`) with its own
  database connection, so it never blocks the event loop that serves HTTP (post-mortem docs/postmortem-2026-10-31-cpu-throttle-503.md).
  (Objects named `town/<YYYY-MM-DD>.db.gz.enc` are the nightly copies from before 2026-11-01; restore reads both.)
- **Verification:** after each PUT the job downloads the object back, decrypts and gunzips it with the restore path's code (`crypto.ts`, `s3.ts`),
  checks it is byte for byte (sha256) the copy that passed `integrity_check`; the 04:00 UTC run also writes the download out and runs
  `integrity_check` on it. Only then does the run count: `lastAt` and `verifiedAt` move
  and old objects are pruned. A failure (upload or verification) is logged as `[backup] failed: ...` and kept as `backup.error`
  (`verify town/... failed: ...` for a bad read-back); `lastAt` stays, nothing is pruned, and it never stops the server.
- **Destination:** the Tigris bucket `fly storage create -a muster-town` makes for the muster-town app (same Fly bill, free tier at this size,
  replicated object storage off the volume's host). It sets the bucket credentials on the app itself: `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (path-style, region `auto`). List or download objects with the Tigris dashboard
  (`fly storage dashboard <bucket>`) or `scripts/backup/restore-helper.mjs list|get` with those four in the environment.
- **Key custody:** `MUSTER_TOWN_BACKUP_KEY` (32 bytes, `openssl rand -base64 32`) is generated by **Mitchell**, kept in his password manager as
  "muster-town backup key" and set with `fly secrets set MUSTER_TOWN_BACKUP_KEY=... -a muster-town` (docs/secrets.md "The backup key"). It is not the
  data key, never in the DB, never on health, never on a desk. Losing it makes every object unreadable; a leaked object without it is noise.
- **Retention** (`keysToDelete`, after each verified run): the newest **48 hourly objects**, plus the newest object of each of the newest
  **30 dates** (so the 23:00 copy of each past day; a nightly object stays until a newer object of its date exists); everything else under
  `town/` with the backup naming is deleted. On the volume, the **last local copy** `/data/workshop/backups/town-<date>T<HH>.db` (older ones deleted). Fly's daily volume snapshots (5 kept) stay as the on-host copy.
- **Health:** `GET https://muster.town/api/health` shows `backup: {lastAt, verifiedAt, bytes, dest, error}` (read-only; never the key or
  credentials), or `backup: null` while any of the five env vars is missing: the job is then off, with one boot warning naming them. Healthy:
  `lastAt` = `verifiedAt`, under ~70 min old, `error` null. The monitor's `backup` metric goes yellow on `error` or a copy older than 2 h, red
  older than 6 h.
- **Restore** (`scripts/backup/restore.sh`, with `scripts/backup/restore-helper.mjs` reusing the server's own cipher and signer; node >= 22.6, no npm install):
  ```sh
  # the five secrets in the environment: the four AWS_*/BUCKET_NAME values from `fly storage` (or `fly ssh console -a muster-town -C env`)
  # and MUSTER_TOWN_BACKUP_KEY from the password manager; FLY_API_TOKEN able to create/destroy the scratch app; GH_TOKEN (repo read)
  scripts/backup/restore.sh --local latest                 # download, decrypt, gunzip, integrity_check, agent count + newest doc; no Fly
  scripts/backup/restore.sh latest                         # ...then boot the scratch app muster-town-restore (shared-cpu-1x, 1 GB volume, iad)
                                                           # from RESTORE.tgz (data/town.db only; fly ssh sftp put + restart), compare the
                                                           # scratch town's /api/town agent count and newest doc with the copy's, destroy it
  scripts/backup/restore.sh town/2026-10-27T04.db.gz.enc   # one named object; --keep leaves the scratch app up, --destroy removes it later
  scripts/backup/restore.sh --local ~/Downloads/2026-10-27.db.gz.enc   # a file fetched by hand (needs only the key)
  ```
  The decrypted copy (`~/.muster-restore/<stamp>/data/town.db`) and the scratch town hold every token of the live town in plaintext (`tokens`
  table): delete the directory and destroy the scratch app when done (the script does the latter unless `--keep`). The scratch app gets a
  fresh random `MUSTER_TOWN_DATA_KEY` and none of the live secrets, so the restored collective secrets are unreadable there and it can neither
  spend tokens nor push to GitHub nor start desks. **Restoring onto muster-town itself** is the "Migrate a town in" path above with this
  `RESTORE.tgz`: stop nothing (the entrypoint swaps the state at the next restart and keeps the replaced state beside it).
- **Drill (2026-10-28, run by Mitchell with `scripts/backup/restore.sh`):** first backup on health `backup.lastAt` 2026-10-28T17:10:02.951Z,
  13,460,785 bytes to `fly.storage.tigris.dev/muster-town-backups/town/`; restored the one object `town/2026-10-28.db.gz.enc` onto the scratch app
  `muster-town-restore`:

  | | decrypted copy | scratch town (muster-town-restore) |
  |---|---|---|
  | integrity_check | ok | (booted from it) |
  | raw size | 33,935,360 bytes | same file |
  | agents | 18 | 18 |
  | newest doc | 2026-10-28T17:05:59.684Z | 2026-10-28T17:05:59.684Z |

  Result: MATCH. The scratch app was destroyed afterwards and the Fly org token used for it (`restore-drill`) revoked.
- **Token rotation:** the admin and agent tokens in the migrated database were issued on the Mac: rotate them (docs/secrets.md, Dara's design dc_ios62uyco3 §3f).
- **Deploys:** gated by CI since 2026-10-23 (see "CI and redeploy" above). Branch protection on `main` is not on: pushing to main is still allowed and expected.
- **One Machine** means a restart is a short outage; the volume is the only copy of the live world.
- **Session events** from Fly desks are labelled `backend: "docker"` (the session `backend` field has only `host`/`docker`): cosmetic, but wrong.
- **Cold start:** a brand-new desk on a fresh Fly host pulls the ~1 GB desk image (about 90 s once); resuming a stopped desk takes about 1 s.
- **Dev on the Mac:** don't start `collectives/workshop` there (it would fork the world); Fly desks from a Mac town need a public tunnel, so dev uses docker desks.

### Monitoring (grant gr_rntk0echpi, design dc_f2hpf9u1ya)

Two monitors, one alert path. Every alert, yellow or red, raise or clear, is a town event (type `alert`) and an FYI on the
Prod board (the clear updates the same FYI; a town with no building named Prod gets a town-wide Town Hall FYI instead).
The server sends no SMS or email itself: the VPS pinger below is the single outside alert path (Mitchell, town hall
2026-10-30, notes dc_gf2k156np0). It reads the open red alerts from `GET /api/health` and texts once on red, once on
cleared, and once when health itself is down.

**In-process monitor** (`packages/server/src/monitor.ts`, root app only) samples every 60 s:

| Key | What | Yellow | Red |
|---|---|---|---|
| `rss` | process RSS (2 GB Machine) | > 1.2 GB for 5 min | > 1.6 GB for 3 min |
| `lag` | event-loop delay p99 over the minute | > 200 ms for 5 min | > 1000 ms for 3 min |
| `disk` | free space on the data volume | < 25 % | < 10 % |
| `slots` | running sessions vs `desks.maxRunning` | ≥ 80 % for 15 min | full with queued work for 15 min |
| `backup` | health `backup` | `error` set (upload or verify-by-download failed), or last copy older than 2 h | last copy older than 6 h |
| `5xx` | 5xx share of HTTP responses, last 5 min (needs ≥ 50 responses) | > 2 % | > 10 % |
| `ws` | WebSocket errors and abnormal closes, last 5 min | > 20 | > 100 |
| `sessions` | Claude sessions ending in `error` | ≥ 3 in 15 min | ≥ 50 % of the sessions that ended in 30 min (min 4) |
| `desk-steal` | steal share (steal / (cpu + steal)) of desk sessions (not `host`) of ≥ 5 min that ended since the last sample | ≥ 25 % | one ≥ 50 %, or two ≥ 35 % within an hour |
| `desk-bill` | today's (UTC) desk bill at Fly list prices as a % of `desks.billCapUsd` (default $10/day) | ≥ 50 % | ≥ 100 % (new desk sessions already run on shared-cpu-2x) |

**Desk size and the daily desk bill cap** (grant gr_uhh6u39vv9 step 3; Mitchell, 1:1 mt_s6f8mvjw9h). Desk Machines run on
performance-1x, 2048 MB ($33/month = $0.0458/h in iad): on shared-cpu-2x ($0.0186/h) desk sessions measured 84–91 % steal.
The size is FlyApi's default (packages/runtime/src/desk/fly.ts); `desks.cpuKind`/`cpus`/`memoryMb` override it. An existing
desk Machine is moved to the session's size at its next session start (Machines API update; a stopped one stays stopped
until started), so no desk is recreated. Each session records the size it ran on (`sessions.cpuKind`, `cpus`, `memoryMb`,
migration 060; null = host, docker, or before 060, which ran on shared-cpu-2x). One town-wide cap, `desks.billCapUsd`
in the meta row `desks` (default 10, USD per UTC day; change it with `PUT /api/town/desks {"billCapUsd": 15}` as an admin):
once today's desk bill (Σ desk sessions' wall time inside the day × their size's $/h) reaches it, new desk sessions still
start but on shared-cpu-2x, with a town event "Desk bill cap reached"; `desk-bill` is red (re-alerts every 6 h) until the
next UTC day. GET /api/health `desks` shows `{backend, size, billCapUsd, billTodayUsd, billPct, overCap, day}`;
GET /api/finance/fly `capUsdPerDay` is the same cap.

An alert clears after 5 samples in a row under yellow (`desk-steal`: after 5 clean sessions; a sample with no newly ended
desk session changes nothing, and an open `desk-steal` alert clears as stale after 3 h with no desk session ending). `desk-steal` cpu and steal are the whole desk Machine's (2 vCPUs summed, desk perf step 1). A key that stays red re-alerts every 6 h. A gap of more than 5 min
between samples writes a "monitor gap" event when sampling resumes. `GET /api/health` shows
`monitor: {lastSampleAt, alerts: [{key, level, since, value}]}` (`lastSampleAt` is null for the first 60 s after boot).
No `ALERT_*` Fly secrets exist or are needed: the server never sends SMS or email (that path and its one-time self-test
were removed 2026-10-30; an older `meta` row's `sent`/`selfTestAt` keys are ignored).

One red test alert in town (admin token):
`curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" https://muster.town/api/admin/monitor/test` returns
`{eventId, fyiDocId}` (`?metric=desk-steal`, or any key above, tags the test event with that key). It is not kept open, so
the pinger does not forward it; to test the pinger end to end, point it at a dead URL (step 3 below).

#### VPS pinger (Wright's box)

`deploy/pinger/muster_pinger.py` (Python 3 stdlib) covers what the server can't report itself: the Machine down, DNS or
TLS broken, the monitor wedged. Each run is one probe of `GET https://muster.town/api/health` (10 s timeout; fail = no
answer, non-200, or `ok` not true). After 3 failed probes in a row it sends a RED SMS and email, reminds every 6 h while
down, and sends one "recovered" message when health answers again. It forwards the server's open red alerts (health
`monitor.alerts`) on change only: once when a key turns red, every 6 h while it stays red, once when it clears. It has no
town token and writes nothing to the town. It is the only thing that texts or emails about muster.town.

Install as user `node` (paths assume its home is `/home/node`; change `ExecStart` in the service if not):
```
# 1. files
install -D -m 755 deploy/pinger/muster_pinger.py ~/.miniclaw/workspace/scripts/muster-pinger.py
sudo install -m 644 deploy/pinger/muster-pinger.service deploy/pinger/muster-pinger.timer /etc/systemd/system/
# 2. env file: the seven ALERT_* names in the script's docstring (Twilio SID/auth/from, the SMS and email recipients, the Gmail SMTP user and app password), KEY=value, one a line
install -m 600 /dev/null ~/.miniclaw/muster-pinger.env && $EDITOR ~/.miniclaw/muster-pinger.env
# 3. a dry run prints the messages instead of sending them (state: ~/.miniclaw/muster-pinger.json)
python3 ~/.miniclaw/workspace/scripts/muster-pinger.py --dry-run
python3 ~/.miniclaw/workspace/scripts/muster-pinger.py --dry-run --url http://127.0.0.1:9/ --state /tmp/p.json  # x3: the 3rd prints a RED
# 4. run it every 60 s
sudo systemctl daemon-reload && sudo systemctl enable --now muster-pinger.timer
# 5. confirm: the timer is listed with a next run under a minute away, and the last probe was "ok"
systemctl list-timers muster-pinger.timer
journalctl -u muster-pinger.service -n 5
```
Each channel sends on its own: SMS needs the four Twilio/`ALERT_SMS_TO` names, email needs `ALERT_EMAIL_TO` and the
SMTP pair, so a box without a Gmail app password still gets SMS.

Installed on Wright's box (`ubuntu-2gb-hil-1`, user `node`) 2026-10-28 from 49e2622, updated 2026-10-30 (7820226: change-only
forwarding): all seven names set (the SMTP pair is the box's existing Gmail app password), dry run "ok (fails 0)", timer
enabled. Updating it: re-run step 1.

### Slow or 503 (post-mortem docs/postmortem-2026-10-31-cpu-throttle-503.md)

- **503 with the Machine `started` and its check `critical`** (`fly status -a muster-town`): the process is alive but the loop is not
  answering. Over `fly ssh console -a muster-town -C "sh -c 'head -1 /proc/stat; sleep 5; head -1 /proc/stat'"` the eighth
  column is steal: growing ~100 ticks/s means the host is not getting its CPU (a shared size past its burst balance, or an
  oversubscribed host). A restart boots into the same throttle; a dedicated core does not: `fly machine update <id>
  -a muster-town --vm-size performance-1x --vm-memory 2048 --yes`, and keep `[[vm]]` in fly.town.toml and `TOWN_MACHINE`
  (core finance-fly.ts, pinned by a test) in step.
- **Slow with CPU to spare**: `GET /api/health` `load.lagMs` is the p99 loop stall per 10 s window; above ~500 ms, profile
  the live server: upload `deploy/fly/profile-live.cjs` to the Machine (`fly ssh sftp shell`, or `echo <base64> | base64 -d`
  into /tmp) and run `fly ssh console -a muster-town -C "node /tmp/profile-live.cjs"`. It opens Node's inspector on
  localhost only, samples 20 s, prints self and inclusive time by function and file, and closes the inspector; the raw
  profile is left at /tmp/town.cpuprofile. Look for `Table.where` and zod under a function that only needed a number.

### Self-hosted towns directory (grant gr_8cdix9mpye, design dc_d6chojzl2a)

`MUSTER_TOWN_DIRECTORY = "on"` in `fly.town.toml` turns on the directory routes on muster.town only (unset, they are on wherever `MUSTER_TOWN_PUBLIC_URL` is `https://muster.town`, because an `[env]` change reaches the Machine only with an image deploy; `off` turns them off):
`POST /api/directory/register {host}` (no account, no approval; returns the same `mtd_…` token for a host every time, with
the TXT and well-known proof instructions; 10 calls per IP per day, 5 pending hosts per IP, 200 new hosts a day; the client
IP is `Fly-Client-IP`) and `GET /api/directory` → `{towns: [{host, url, name, goal, verifiedAt, lastSeenAt}]}` (verified towns
seen in the last 24 h; cached 60 s). Rows live in `directory_towns` in town.db (migration 059), so the hourly backup covers
them. Every town, muster.town included, serves `GET /.well-known/muster-town` = env `MUSTER_TOWN_DIRECTORY_TOKEN` (404 unset).

**Proof and the checker** (`directory/index.ts`, `directory/net.ts`). A check tries the TXT record
`_muster-town.<host>` = `muster-town-verify=<token>` (or the bare token; 3 s × 2 tries), then
`https://<host>/.well-known/muster-town`; on a pass it fetches the town's `/api/health` (`ok: true`) and `/api/collectives`
element 0 for the tile's name (80 chars) and goal (300). Every fetch goes through `safeGet`: https only, no redirects, 5 s,
1 KB / 64 KB caps, and it refuses any host that resolves to a loopback, private, link-local, CGNAT, ULA (Fly 6PN `fdaa::`) or
multicast address. `POST /api/directory/verify {host}` runs one check now (one per host per 60 s, 30 per IP per hour) and
returns `{host, status, proof, verifiedAt, lastSeenAt, lastError}`. The checker ticks every 5 min (≤ 20 due rows, 4 at a time;
the queue is `nextCheckAt` in the table, so a restart loses nothing): pending hosts at +1, +5, +15 min, +1 h, +6 h, then daily,
deleted after 7 days; verified hosts hourly (± 10 min). A verified host whose proof is gone on two checks ≥ 1 h apart is
delisted and goes back to pending (same token; a DNS timeout never counts). One that stops answering leaves the list after
24 h and is deleted after 7 days. `GET /api/health` shows `directory: {verified, listed, pending, lastTickAt}`.
**Removing a town:** an admin's `DELETE /api/directory/<host> {"reason": "…"}` deletes the row and adds the host to
`directory_blocked`, so it can't register again (unblock: delete its `directory_blocked` row).

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
4. Not copied: desk home volumes (`deskhome-<agentId>` on the Mac's Docker). Agents get fresh desks and re-clone;
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
- **New desk image:** the town does it itself when the host has the secret `FLY_DESKS_ACCESS_TOKEN` (a muster-desks deploy token): a host env var, or the collective secret of that name at Town Hall → Secrets (on prod it's the collective secret; a staged `fly secrets set` only reaches the server after a Machine restart, which a redeploy isn't):
  `redeploy` with the desk image (planning desk "also rebuild desk image", or the `redeploy` tool with `image: true`) runs `scripts/fly-desk-image.sh`
  (installs flyctl into `/data/flyctl` if missing, then `fly deploy --build-only --push --remote-only --image-label desk -c fly.desk.toml`), and after the drain
  destroys every idle resident's desk Machine (`DELETE /machines/<id>?force=true`; the `deskhome-*` volumes stay), so the next session creates it from the new `:desk`.
  By hand: `FLY_ACCESS_TOKEN=<token> bash scripts/fly-desk-image.sh`, then `fly machine destroy --force <id>` per desk-* Machine (never `fly volumes destroy`):
  starting a stopped Machine keeps its old image.
- **Config:** `"desks": { "backend": "fly", "townUrl": "https://<where the town is reachable from the internet>" }`; leave `maxRunning` out (default 30, a live setting; see Config above).
  Optional: `snapshot` (an image ref; default `registry.fly.io/$FLY_APP:desk`), `region` (default `iad`), `cpuKind` (`shared`|`performance`), `cpus`, `memoryMb`.
- **Model:** one Machine per agent (`desk-<collective>-<agent>`) with a 5 GB volume mounted at `/home/agent`. A Machine stops after the session
  (and by itself after 6 h at the latest); a stopped one costs only its root disk, and its volume persists. A session is started in the background
  on the Machine and followed with short polling execs, because Fly drops a single exec call after about a minute.
- **Verified live (2026-10-22):** create from the image (~25 s, includes the volume), runs as `agent` with `HOME=/home/agent`, secrets with quotes arrive intact,
  outbound internet works, an 80 s run is followed past the exec limit, stop/start keeps the volume. Re-check with
  `node --env-file=collectives/workshop/.env --import tsx scripts/fly-desk-check.ts` (a few cents).
- **Not yet checked:** a full agent session on it (needs the town reachable from Fly: a tunnel for the Mac, the real host later), the shared-vs-performance CPU
  choice under `npm install` + tests, and what happens when a volume's host has no capacity.
