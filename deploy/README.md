# Deploying Muster Town to muster.town

Prod is one box (`muster-prod-1`, OVH d2-8: 4 vCPU, 7.6 GB RAM, Ubuntu 24.04, 15.204.79.179) running the Workshop
collective: one town process behind Caddy, desks as Docker containers on the same box. Plan and reasoning: town docs
dc_mltonxkizi (deploy + CI) and dc_vxgg8r55ha (stress test: 6 desks at once).

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
3. Mitchell fills `/etc/muster-town/env` over SSH (never through an agent): `CLAUDE_CODE_OAUTH_TOKEN`, the
   `DESK_ENV_*` the Workshop uses, and later `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`MUSTER_TOWN_SESSION_SECRET`.
   Then `sudo systemctl restart muster-town`.
4. Desks get `GH_TOKEN` from `gh auth token` (collective `desks.ghToken` default `gh-cli`): log the `muster` user in
   with a **fine-grained PAT** for this repo only (contents + pull requests):
   `sudo -u muster -H gh auth login --with-token < pat.txt`.
5. Cap work sessions at **6** (live setting, kept in the database; redo it after copying in a `town.db`):
   `curl -X PUT http://127.0.0.1:4322/api/town/desks -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"maxRunning":6}'`
   (`$ADMIN`: the admin token from `journalctl -u muster-town`).
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
