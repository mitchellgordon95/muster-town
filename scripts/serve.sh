#!/bin/zsh
# Supervisor for one collective's server: restarts it when it exits 75 (the `redeploy` verb / POST /api/admin/redeploy
# asks for a restart that way after pulling main and rebuilding). Any other exit code ends the loop with that code.
# Usage: scripts/serve.sh <collective dir>   e.g. scripts/serve.sh collectives/workshop
set -u
if [[ $# -lt 1 ]]; then
  echo "usage: scripts/serve.sh <collective dir>" >&2
  exit 2
fi
cd "${0:A:h}/.." || exit 1
export AGENT_TOWN_COLLECTIVE="$1"
while true; do
  npx tsx packages/server/src/main.ts
  code=$?
  if [[ $code -eq 75 ]]; then
    echo "[serve] restart requested"
    continue
  fi
  exit $code
done
