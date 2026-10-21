#!/usr/bin/env bash
# Cutover, box side: replace prod's world with the Mac's Workshop town.db, then put the live settings back. Run as root
# after copying the Mac's backup up (deploy/README.md "Cutover" has the Mac side):
#   sudo bash deploy/cutover.sh /tmp/town.db
# Keeps the world it replaces in /var/backups/muster-town/pre-cutover-<time>.db. Safe to re-run with the same file.
set -euo pipefail

DB_IN="${1:?usage: cutover.sh <town.db copied from the Mac>}"
DIR=/srv/muster-town
DATA=$DIR/collectives/workshop/data
MAX_RUNNING="${MAX_RUNNING:-6}"
say() { echo "[cutover] $*"; }

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
[[ -f $DB_IN ]] || { echo "no such file: $DB_IN" >&2; exit 1; }
[[ "$(sqlite3 "$DB_IN" 'PRAGMA integrity_check')" == ok ]] || { echo "$DB_IN fails integrity_check" >&2; exit 1; }

say "stopping muster-town (running sessions are cut off; the Mac town should already be stopped)"
systemctl stop muster-town
if [[ -f $DATA/town.db ]]; then
  keep=/var/backups/muster-town/pre-cutover-$(date +%Y%m%dT%H%M%S).db
  sudo -u muster sqlite3 "$DATA/town.db" ".backup $keep"
  say "kept the old world in $keep"
fi
# the copied db is a clean .backup: stale -wal/-shm from the old world must not be replayed onto it
rm -f "$DATA/town.db" "$DATA/town.db-wal" "$DATA/town.db-shm"
install -o muster -g muster -m 600 "$DB_IN" "$DATA/town.db"

systemctl start muster-town
say "waiting for /api/health"
for _ in $(seq 60); do curl -fs http://127.0.0.1:4322/api/health >/dev/null && break; sleep 2; done
curl -fs http://127.0.0.1:4322/api/health || { echo; echo "server did not come up: journalctl -u muster-town -n 50" >&2; exit 1; }
echo

# the server rewrites admin-token from the db on start, so this is the Mac's admin token (rotate it: README)
ADMIN="$(tr -d '\n' < "$DATA/admin-token")"
say "setting maxRunning $MAX_RUNNING (it lives in the db, so the Mac's value came along)"
curl -fs -X PUT http://127.0.0.1:4322/api/town/desks -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d "{\"maxRunning\":$MAX_RUNNING}"
echo
say "done. Next: rotate secrets and check a resident session (deploy/README.md)"
