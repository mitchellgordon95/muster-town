#!/bin/sh
# Supervisor for the town on Fly: keeps the checkout on the volume, restores a migrated town if one was uploaded, and restarts the
# server when it exits 75 (the `redeploy` verb) like scripts/serve.sh does. Any other exit code ends the container (Fly restarts it).
set -eu

REPO=/data/repo
COLLECTIVE="${MUSTER_TOWN_COLLECTIVE:-collectives/workshop}"
mkdir -p /data

if [ ! -d "$REPO/.git" ]; then
  echo "[entrypoint] first boot: copying the baked checkout to $REPO"
  cp -a /opt/seed "$REPO"
fi
cd "$REPO"

# commit identity for the export and the redeploy's rebase
export GIT_AUTHOR_NAME="Muster Town" GIT_AUTHOR_EMAIL="town@muster.town" GIT_COMMITTER_NAME="Muster Town" GIT_COMMITTER_EMAIL="town@muster.town"

# GitHub access for pull/redeploy comes from the environment (a fine-grained token); it is never written to disk
git remote set-url origin "https://github.com/mitchellgordon95/agent-town.git"
if [ -n "${GH_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
fi

# a migrated town: upload RESTORE.tgz (town.db, admin-token, session-secret, export/) to /data and restart the Machine
if [ -f /data/RESTORE.tgz ]; then
  echo "[entrypoint] restoring the town from /data/RESTORE.tgz"
  mkdir -p "$COLLECTIVE"
  rm -rf "$COLLECTIVE/data" "$COLLECTIVE/export"
  tar -xzf /data/RESTORE.tgz -C "$COLLECTIVE"
  mv /data/RESTORE.tgz "/data/RESTORE.done-$(date +%Y%m%d%H%M%S).tgz"
fi

while true; do
  code=0
  npx tsx packages/server/src/main.ts || code=$?
  if [ "$code" -eq 75 ]; then
    echo "[entrypoint] restart requested"
    continue
  fi
  echo "[entrypoint] server exited with $code"
  exit "$code"
done
