#!/bin/sh
# Recover muster.town from a dead volume or host (grant gr_z2v838adk9; deploy/README.md "Recover"). One command for a human with the
# fly CLI: a new volume, a new Machine on it from a fresh image, the server's first-boot restore (packages/server/src/backup/restore.ts)
# makes town.db from the newest good hourly copy in the bucket, then the script waits for health and compares the live town with the copy.
#
# Usage: deploy/recover.sh [--yes] [--keep] [APP]          APP default muster-town; any other name is a throwaway drill app
#        deploy/recover.sh --compare <town.db> <agents> <newest-doc>   compare a local copy with given live numbers (no Fly)
#   (no --yes)  dry run: print every command it would run, change nothing. Read them, then run again with --yes.
#   --keep      a throwaway APP: leave it running at the end (default: destroy it; it is a writer to the live bucket, see below)
# What it does, in order (muster-town: refuses while https://muster.town/api/health still answers ok):
#   1. throwaway APP only: create the app and stage its secrets: the five backup values from this shell's environment and a fresh
#      random MUSTER_TOWN_DATA_KEY (no Claude token, no GitHub, no desks).
#   2. fly volumes create town_data (SIZE GB, default 10 like the live one; REGION default iad). "volume created" is timed from here.
#   3. destroy the old Machine (--force: on a dead host it can't stop). The old volume is left alone (snapshots: fly volumes snapshots list).
#   4. deploy/fly/build.sh APP: a fresh image from GitHub BRANCH (default prod, the last green commit), so the first boot runs code that
#      has the first-boot restore and the empty-boot guard. fly deploy makes one Machine and mounts the unattached town_data volume.
#   5. check the new Machine mounts the NEW volume (fly deploy could pick another unattached town_data; then it stops with what to do).
#   6. poll https://<host>/api/health until ok; print the elapsed time from "volume created" to "health ok".
#   7. the numbers: the server's "[restore] <key>: ok, N agents" log line; agents (/api/town) and newest doc (sqlite3 over fly ssh)
#      on the live app; and, when this shell has MUSTER_TOWN_BACKUP_KEY and the bucket values, the same two from that very key
#      (scripts/backup/restore.sh --local <key>), with MATCH or MISMATCH. A "seeding a new town" log line means the restore did not
#      happen: the guard then keeps the empty town from uploading ("fresh town; restore first" on health); see README "Recover".
# Environment: FLY_API_TOKEN or `fly auth login` (an org token for a throwaway: fly tokens create org -o personal -n recover-drill -x 24h);
#   GH_TOKEN (repo read) or git ssh access, for build.sh's clone; for a throwaway or for the copy comparison also BUCKET_NAME,
#   AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, MUSTER_TOWN_BACKUP_KEY. HOST overrides the health host
#   (default muster.town for muster-town, else <APP>.fly.dev).
# Drill trap: an app with the five backup secrets writes hourly copies to the same bucket. A throwaway must be gone before the next top of
#   the hour (the script destroys it unless --keep), or muster.town's next run fails with "... is already in the bucket".
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
HELPER="node --experimental-strip-types --no-warnings $REPO/scripts/backup/restore-helper.mjs"
REGION="${REGION:-iad}"
SIZE="${SIZE:-10}"
BRANCH="${BRANCH:-prod}"

say() { echo "[recover] $*"; }
now() { date -u +%s; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --compare <db> <agents> <newest>: the copy's numbers (restore-helper check) against the live ones; prints MATCH or MISMATCH
compare() {
  copy="$($HELPER check "$1")" || { echo "$copy"; say "integrity_check FAILED on $1"; return 1; }
  c_agents="$(echo "$copy" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).agents')"
  c_newest="$(echo "$copy" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).newestDocAt')"
  printf '%-12s %-28s %s\n' "" "copy" "live" "agents" "$c_agents" "$2" "newest doc" "$c_newest" "$3"
  if [ "$c_agents" = "$2" ] && [ "$c_newest" = "$3" ]; then say "MATCH: the live town is the copy"; else say "MISMATCH between the copy and the live town"; return 1; fi
}
if [ "${1:-}" = --compare ]; then
  [ $# -eq 4 ] || { echo "usage: $0 --compare <town.db> <agents> <newest-doc>"; exit 2; }
  compare "$2" "$3" "$4"; exit $?
fi

YES=0; KEEP=0; APP=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1;; --keep) KEEP=1;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    --*) echo "unknown flag $a"; exit 2;;
    *) [ -z "$APP" ] || { echo "too many arguments"; exit 2; }; APP="$a";;
  esac
done
APP="${APP:-muster-town}"
case "$APP" in muster-desks) echo "refusing: $APP is the desks app"; exit 2;; esac
LIVE=0; [ "$APP" = muster-town ] && LIVE=1
if [ "$LIVE" = 1 ]; then HOST="${HOST:-muster.town}"; else HOST="${HOST:-$APP.fly.dev}"; fi
FLY="${FLY:-fly}"; command -v "$FLY" >/dev/null 2>&1 || FLY=flyctl

# run: the command, printed; executed only with --yes
run() { echo "+ $*"; [ "$YES" = 1 ] || return 0; "$@"; }
health() { curl -s -m 10 "https://$HOST/api/health" 2>/dev/null || true; }

[ "$YES" = 1 ] || say "DRY RUN (nothing changes; ids below are placeholders). Run again with --yes to do it."
if [ "$YES" = 1 ]; then
  command -v "$FLY" >/dev/null 2>&1 || { echo "flyctl not found (curl -L https://fly.io/install.sh | sh)"; exit 1; }
  if [ "$LIVE" = 1 ] && health | grep -q '"ok":true'; then
    say "https://$HOST/api/health answers ok: the town is up, this is for a dead volume or host. Nothing done."; exit 1
  fi
fi

# 1. a throwaway app: create it and stage its secrets
if [ "$LIVE" = 0 ]; then
  for v in BUCKET_NAME AWS_ENDPOINT_URL_S3 AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY MUSTER_TOWN_BACKUP_KEY; do
    eval "[ -n \"\${$v:-}\" ]" || { [ "$YES" = 0 ] && say "(would need $v)"; [ "$YES" = 0 ] || { echo "$v is not set: a throwaway restores from the bucket"; exit 2; }; }
  done
  if [ "$YES" = 0 ] || ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
    run "$FLY" apps create "$APP" --org "${FLY_ORG:-personal}"
  fi
  echo "+ $FLY secrets set -a $APP --stage BUCKET_NAME=… AWS_ENDPOINT_URL_S3=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… MUSTER_TOWN_BACKUP_KEY=… MUSTER_TOWN_DATA_KEY=<fresh>"
  if [ "$YES" = 1 ]; then
    "$FLY" secrets set -a "$APP" --stage "BUCKET_NAME=$BUCKET_NAME" "AWS_ENDPOINT_URL_S3=$AWS_ENDPOINT_URL_S3" \
      "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY" \
      "MUSTER_TOWN_BACKUP_KEY=$MUSTER_TOWN_BACKUP_KEY" "MUSTER_TOWN_DATA_KEY=$(openssl rand -base64 32)" >/dev/null
  fi
fi

# 2. the new volume ("volume created" starts the clock)
if [ "$YES" = 1 ]; then OLD_MACHINES="$("$FLY" machine list -a "$APP" -q 2>/dev/null | tr -d ' \t\r' | grep -v '^$' || true)"
elif [ "$LIVE" = 1 ]; then OLD_MACHINES='<old-machine>'; else OLD_MACHINES=''; fi
run "$FLY" volumes create town_data -a "$APP" -r "$REGION" -s "$SIZE" --yes
T0="$(now)"; CREATED="$(stamp)"
VOL='<new-volume>'
if [ "$YES" = 1 ]; then
  VOL="$("$FLY" volumes list -a "$APP" --json | node -pe 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")).filter((x)=>x.name==="town_data"&&!x.attached_machine_id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]; v?v.id:""')"
  [ -n "$VOL" ] || { say "could not find the new town_data volume"; exit 1; }
fi
say "volume created: $VOL at $CREATED"

# 3. the old Machine (pinned to the dead volume's host) goes; its volume stays
for m in $OLD_MACHINES; do run "$FLY" machine destroy "$m" -a "$APP" --force; done

# 4. a fresh image and one Machine on the new volume
set -- "$APP" --yes --regions "$REGION"
if [ "$LIVE" = 0 ]; then
  set -- "$@" --env "MUSTER_TOWN_PUBLIC_URL=https://$HOST" --env 'MUSTER_TOWN_DESKS={"backend":"docker","maxRunning":1}' --env "FLY_APP=none"
fi
if [ -n "${GH_TOKEN:-}" ] && [ -z "${REPO_URL:-}" ]; then REPO_URL="https://x-access-token:$GH_TOKEN@github.com/mitchellgordon95/muster-town.git"; export REPO_URL; fi
echo "+ BRANCH=$BRANCH $REPO/deploy/fly/build.sh $*"
[ "$YES" = 0 ] || BRANCH="$BRANCH" "$REPO/deploy/fly/build.sh" "$@"

# 5. the new Machine must mount the new volume
if [ "$YES" = 1 ]; then
  ON="$("$FLY" volumes list -a "$APP" --json | node -pe "(JSON.parse(require('fs').readFileSync(0,'utf8')).find((x)=>x.id==='$VOL')||{}).attached_machine_id||''")"
  if [ -z "$ON" ]; then
    say "the new Machine did not take $VOL (fly deploy picked another unattached town_data volume): fly volumes list -a $APP."
    say "Destroy that Machine (fly machine destroy <id> -a $APP --force), keep the old volume, and attach the new one with"
    say "  fly machine clone <any-machine> -a $APP --attach-volume $VOL:/data   or move the old volume out of the way, then rerun."
    exit 1
  fi
  say "Machine $ON mounts $VOL"
fi

# 6. health
echo "+ poll https://$HOST/api/health until ok (every 5 s, up to 30 min)"
if [ "$YES" = 1 ]; then
  i=0
  until health | grep -q '"ok":true'; do
    i=$((i + 1)); [ "$i" -gt 360 ] && { say "https://$HOST/api/health never came up: fly logs -a $APP"; exit 1; }
    sleep 5
  done
fi
T1="$(now)"; OK_AT="$(stamp)"
[ "$YES" = 1 ] || { say "dry run done"; exit 0; }
ELAPSED=$((T1 - T0))
say "health ok at $OK_AT: $((ELAPSED / 60)) min $((ELAPSED % 60)) s after the volume was created ($CREATED)"

# 7. what was restored, and the live numbers against the copy's
LOG="$("$FLY" logs -a "$APP" --no-tail 2>/dev/null | grep '\[restore\]' || true)"
echo "$LOG"
KEY="$(echo "$LOG" | sed -n 's/.*\[restore\] \(town\/[^:]*\): ok,.*/\1/p' | tail -n 1)"
if [ -z "$KEY" ]; then say "no \"[restore] <key>: ok\" line: the town did NOT restore (README \"Recover\": what to do)"; fi
LIVE_AGENTS="$(curl -s -m 20 "https://$HOST/api/town" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); (s.agents||[]).length')"
LIVE_NEWEST="$("$FLY" ssh console -a "$APP" -C "sqlite3 -readonly /data/workshop/data/town.db 'SELECT max(createdAt) FROM docs'" | tr -d '\r' | tail -n 1)"
say "live: $LIVE_AGENTS agents, newest doc $LIVE_NEWEST, health $(health | head -c 400)"
if [ -n "$KEY" ] && [ -n "${MUSTER_TOWN_BACKUP_KEY:-}" ] && [ -n "${BUCKET_NAME:-}" ]; then
  RESTORE_DIR="${RESTORE_DIR:-$HOME/.muster-restore}"; export RESTORE_DIR
  "$REPO/scripts/backup/restore.sh" --local "$KEY" >/dev/null
  for d in "$RESTORE_DIR"/*/data/town.db; do DB="$d"; done # stamp-named dirs: the last one is restore.sh's
  compare "$DB" "$LIVE_AGENTS" "$LIVE_NEWEST" || true
  say "delete $(dirname "$(dirname "$DB")") when done (the decrypted copy holds every token of the town)"
else
  say "copy comparison skipped (needs the key line above, MUSTER_TOWN_BACKUP_KEY and the bucket values in this shell)"
fi
echo "drill row: | $CREATED | $OK_AT | $((ELAPSED / 60)) min $((ELAPSED % 60)) s | $LIVE_AGENTS | $LIVE_NEWEST | ${KEY:-?} |"

# a throwaway is a writer to the live bucket: gone before the top of the hour
if [ "$LIVE" = 0 ]; then
  if [ "$KEEP" = 1 ]; then say "--keep: destroy $APP before the next top of the hour: $FLY apps destroy $APP --yes"
  else say "destroying $APP"; "$FLY" apps destroy "$APP" --yes; fi
fi
