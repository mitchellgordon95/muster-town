#!/usr/bin/env bash
# Supervisor for one collective's server: restarts it when it exits 75 (the `redeploy` verb / POST /api/admin/redeploy
# asks for a restart that way after pulling main and rebuilding). Any other exit code ends the loop with that code.
# Usage: scripts/serve.sh <collective dir>   e.g. scripts/serve.sh collectives/workshop
#        npm run start:collective -- collectives/<id>
set -u
if [[ $# -lt 1 ]]; then
  echo "usage: scripts/serve.sh <collective dir>   (or: npm run start:collective -- collectives/<id>)" >&2
  exit 2
fi
cd "$(dirname "$0")/.." || exit 1
if [[ ! -f "$1/collective.json" ]]; then
  echo "serve.sh: no $1/collective.json (copy collectives/workshop to start one; see README.md, Run it)" >&2
  exit 2
fi
export MUSTER_TOWN_COLLECTIVE="$1"
while true; do
  npx tsx packages/server/src/main.ts
  code=$?
  if [[ $code -eq 75 ]]; then
    echo "[serve] restart requested"
    continue
  fi
  exit $code
done
