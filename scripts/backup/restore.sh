#!/bin/sh
# Restore drill for the off-site backup (grant gr_jkorz4f49a; deploy/README.md "Backups"): take one object the server wrote
# (town/<date>.db.gz.enc: gzip(town.db), AES-256-GCM under MUSTER_TOWN_BACKUP_KEY), turn it back into a database, check it, and boot a
# scratch town from it on Fly to prove the copy is a town, not just a file. The live town (muster-town) is never touched: this script
# refuses that app name, and the scratch app gets none of the live secrets (a fresh random data key, no GitHub, no desks). The restored
# town.db does carry the Bank's Claude token, so the scratch app runs with MUSTER_TOWN_RUNTIME=off (server throwaway.ts): no sessions.
#
# Usage: scripts/backup/restore.sh [--local] [--keep] [--yes] <object|latest|file.db.gz.enc> [scratch-app]
#        scripts/backup/restore.sh --destroy [scratch-app]
#   <object>      an object key (town/2026-10-27.db.gz.enc), `latest` (the newest key in the bucket) or a local .db.gz.enc file
#   scratch-app   the Fly app to restore onto (default muster-town-restore; created when missing: shared-cpu-1x, 1 GB volume, iad)
#   --local       stop after the integrity check and the counts (no Fly, no flyctl needed): exercises download + decrypt + check
#   --keep        leave the scratch app running at the end (default: destroy it, it carries the live town's tokens)
#   --yes         don't ask before creating or destroying the scratch app
#   --destroy     only destroy the scratch app (after a --keep run)
# Environment: BUCKET_NAME, AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (the ones `fly storage create` set on
#   muster-town: `fly secrets list -a muster-town` shows their names, `fly storage` / the Tigris dashboard the values) and
#   MUSTER_TOWN_BACKUP_KEY (Mitchell's password manager, "muster-town backup key"). A local file needs only the key.
#   FLY_API_TOKEN: a Fly token that may create and destroy the scratch app (never the live town's deploy token:
#   `fly tokens create org -o personal -n restore-drill -x 24h`, revoke it after). GH_TOKEN: repo read, to build the
#   scratch image from GitHub (deploy/fly/build.sh). RESTORE_DIR (default ~/.muster-restore) keeps the downloaded and decrypted copies
#   (0700; delete it when done: the decrypted copy holds every token of the live town).
# Needs: node >= 22.6 (node:sqlite, or a `sqlite3` binary), tar, curl; flyctl for the Fly part. No npm install.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HELPER="node --experimental-strip-types --no-warnings $HERE/restore-helper.mjs"
RESTORE_DIR="${RESTORE_DIR:-$HOME/.muster-restore}"
REGION="${REGION:-iad}"
LIVE_URL="${LIVE_URL:-https://muster.town}"

LOCAL=0; KEEP=0; YES=0; DESTROY=0; OBJECT=""; APP=""
for a in "$@"; do
  case "$a" in
    --local) LOCAL=1;; --keep) KEEP=1;; --yes) YES=1;; --destroy) DESTROY=1;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    --*) echo "unknown flag $a"; exit 2;;
    *) if [ "$DESTROY" = 1 ] && [ -z "$APP" ]; then APP="$a"; elif [ -z "$OBJECT" ]; then OBJECT="$a"; elif [ -z "$APP" ]; then APP="$a"; else echo "too many arguments"; exit 2; fi;;
  esac
done
APP="${APP:-muster-town-restore}"
HOST="$APP.fly.dev"
# belt and braces: this script only ever creates, fills and destroys a scratch app
case "$APP" in muster-town|muster-desks|muster-town-stress) echo "refusing to touch $APP: restore onto a scratch app only"; exit 2;; esac

say() { echo "[restore] $*"; }
confirm() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r ans; [ "$ans" = y ] || [ "$ans" = Y ]; }
health() { curl -s -m 10 "https://$HOST/api/health"; }
wait_health() {
  i=0
  until health | grep -q '"ok":true'; do
    i=$((i + 1)); [ "$i" -gt "${1:-90}" ] && { say "https://$HOST/api/health never came up"; "$FLY" status -a "$APP" || true; return 1; }
    sleep 5
  done
}
need_fly() {
  FLY="${FLY:-fly}"
  command -v "$FLY" >/dev/null 2>&1 || FLY=flyctl
  command -v "$FLY" >/dev/null 2>&1 || { echo "flyctl not found (curl -L https://fly.io/install.sh | sh); --local needs none"; exit 1; }
  : "${FLY_API_TOKEN:?set FLY_API_TOKEN to an org token that may create and destroy $APP, e.g. fly tokens create org -o personal -n restore-drill -x 24h, never the live town deploy token}"
}
destroy_app() {
  if "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
    confirm "destroy the scratch app $APP (Machines and volume)?" || { say "kept $APP; destroy it later with: $0 --destroy $APP"; return 0; }
    say "destroying $APP"
    "$FLY" apps destroy "$APP" --yes
  else
    say "no app $APP to destroy"
  fi
}

if [ "$DESTROY" = 1 ]; then need_fly; destroy_app; exit 0; fi
[ -n "$OBJECT" ] || { sed -n '6,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node >= 22.6 is needed"; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "node >= 22.6 is needed (found $(node --version))"; exit 1; }

mkdir -p "$RESTORE_DIR"; chmod 700 "$RESTORE_DIR"
umask 077
WORK="$RESTORE_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK/data"

# 1. the object: a local file, the newest key, or the key given
if [ -f "$OBJECT" ]; then
  BLOB="$OBJECT"; NAME="$(basename "$OBJECT")"
  say "local object $OBJECT ($(wc -c < "$BLOB" | tr -d ' ') bytes)"
else
  for v in BUCKET_NAME AWS_ENDPOINT_URL_S3 AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do eval "[ -n \"\${$v:-}\" ]" || { echo "$v is not set (the bucket credentials fly storage create set on muster-town)"; exit 2; }; done
  if [ "$OBJECT" = latest ]; then
    OBJECT="$($HELPER list | tail -n 1)"
    [ -n "$OBJECT" ] || { say "the bucket $BUCKET_NAME has no town/<date>T<HH>.db.gz.enc object yet"; exit 1; }
    say "newest object: $OBJECT"
  fi
  NAME="$(basename "$OBJECT")"
  BLOB="$WORK/$NAME"
  say "downloading $OBJECT from $BUCKET_NAME"
  $HELPER get "$OBJECT" "$BLOB"
fi
# a raw object is not a database (testing plan line 2)
if head -c 15 "$BLOB" | grep -q "SQLite format 3"; then say "WARNING: $NAME is an unencrypted SQLite file, not a backup object"; fi

# 2. decrypt + gunzip, then the checks on the copy (read-only)
: "${MUSTER_TOWN_BACKUP_KEY:?set MUSTER_TOWN_BACKUP_KEY from the password manager entry muster-town backup key}"
DB="$WORK/data/town.db"
$HELPER decrypt "$BLOB" "$DB"
say "integrity_check and counts on the copy"
COPY_JSON="$($HELPER check "$DB")" || { echo "$COPY_JSON"; say "integrity_check FAILED on the copy; nothing restored"; exit 1; }
echo "$COPY_JSON"
COPY_AGENTS="$(echo "$COPY_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).agents')"
COPY_NEWEST="$(echo "$COPY_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).newestDocAt')"
say "copy: integrity ok, $COPY_AGENTS agents, newest doc $COPY_NEWEST"

# 3. RESTORE.tgz with data/town.db only: the entrypoint (deploy/fly/entrypoint.sh) swaps it in at boot; session-secret is created again,
# the admin token stays the one in the database's tokens table (so the scratch town answers to the live tokens: destroy it when done)
TGZ="$WORK/RESTORE.tgz"
tar -czf "$TGZ" -C "$WORK" data/town.db
say "RESTORE.tgz: $(wc -c < "$TGZ" | tr -d ' ') bytes at $TGZ"

if [ "$LOCAL" = 1 ]; then
  say "--local: stopping here. Copy: $DB. Delete $WORK when done (the copy holds every token of the live town)."
  exit 0
fi

# 4. the scratch app: created when missing, same image as the town (built from GitHub main), smaller Machine, no live secrets
need_fly
export FLY_API_TOKEN
if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  confirm "create the scratch app $APP (shared-cpu-1x, 1 GB volume, $REGION; about \$0.01/h while it runs)?" || exit 1
  say "creating app $APP"
  "$FLY" apps create "$APP" --org "${FLY_ORG:-personal}"
fi
if ! "$FLY" volumes list -a "$APP" 2>/dev/null | grep -q "town_data"; then
  say "creating volume town_data (1 GB, $REGION)"
  "$FLY" volumes create town_data -a "$APP" -r "$REGION" -s 1 --yes
fi
if ! "$FLY" secrets list -a "$APP" 2>/dev/null | grep -q "MUSTER_TOWN_DATA_KEY"; then
  say "setting a fresh MUSTER_TOWN_DATA_KEY (the scratch app's only secret: the live collective secrets stay unreadable)"
  "$FLY" secrets set -a "$APP" --stage "MUSTER_TOWN_DATA_KEY=$(openssl rand -base64 32)"
fi
if ! health | grep -q '"ok":true'; then
  say "building the town image from GitHub ${BRANCH:-main} and deploying it to $APP (shared-cpu-1x / 1 GB)"
  REPO_URL="${REPO_URL:-https://x-access-token:${GH_TOKEN:?GH_TOKEN (repo read) is needed to clone the private repo}@github.com/mitchellgordon95/muster-town.git}" \
    "$REPO/deploy/fly/build.sh" "$APP" --yes --regions "$REGION" --vm-size shared-cpu-1x --vm-memory 1024 \
      --env "MUSTER_TOWN_RUNTIME=off" \
      --env "MUSTER_TOWN_PUBLIC_URL=https://$HOST" \
      --env 'MUSTER_TOWN_DESKS={"backend":"docker","maxRunning":1}' \
      --env "FLY_APP=none"
  say "waiting for https://$HOST/api/health"
  wait_health 90
fi

# 5. upload, restart, wait, compare
say "uploading RESTORE.tgz to /data/RESTORE.tgz on $APP"
"$FLY" ssh sftp put "$TGZ" /data/RESTORE.tgz -a "$APP"
MACHINE="$("$FLY" machine list -a "$APP" -q | tr -d ' \t\r' | grep -v '^$' | head -n 1)"
say "restarting Machine $MACHINE (the entrypoint swaps the restored town in)"
"$FLY" machine restart "$MACHINE" -a "$APP"
sleep 5
wait_health 60
SCRATCH_AGENTS="$(curl -s -m 20 "https://$HOST/api/town" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); (s.agents||[]).length')"
SCRATCH_NEWEST="$("$FLY" ssh console -a "$APP" -C "sqlite3 -readonly /data/workshop/data/town.db 'SELECT max(createdAt) FROM docs'" | tr -d '\r' | tail -n 1)"
LIVE_AGENTS="$(curl -s -m 20 "$LIVE_URL/api/town" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); (s.agents||[]).length' 2>/dev/null || echo '?')"
echo
echo "object              $NAME"
echo "                    copy (decrypted)       scratch town ($HOST)      live town now ($LIVE_URL)"
echo "agents              $COPY_AGENTS                     $SCRATCH_AGENTS                     $LIVE_AGENTS"
echo "newest doc          $COPY_NEWEST   $SCRATCH_NEWEST"
if [ "$COPY_AGENTS" = "$SCRATCH_AGENTS" ] && [ "$COPY_NEWEST" = "$SCRATCH_NEWEST" ]; then say "MATCH: the scratch town is the copy"; else say "MISMATCH between the copy and the scratch town: look at fly logs -a $APP"; fi
say "health: $(health)"

# 6. destroy (the scratch town carries the live tokens), unless --keep
if [ "$KEEP" = 1 ]; then say "--keep: $APP left running; destroy it with: $0 --destroy $APP"; else destroy_app; fi
say "done. Delete $WORK when finished (the decrypted copy holds every token of the live town)."
