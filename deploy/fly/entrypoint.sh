#!/bin/sh
# Supervisor for the town on Fly: keeps the checkout on the volume, keeps the town's state beside it (never inside it), restores a
# migrated town if one was uploaded, and restarts the server when it exits 75 (the `redeploy` verb) like scripts/serve.sh does.
# Any other exit code ends the container (Fly restarts it).
set -eu

REPO=/data/repo
COLLECTIVE="${MUSTER_TOWN_COLLECTIVE:-collectives/workshop}"
# state (town.db, admin-token, session-secret, the export mirror) lives outside the checkout, so replacing or deleting
# /data/repo can never touch it. fly.town.toml sets the same paths; these defaults cover a Machine without them.
STATE="/data/$(basename "$COLLECTIVE")"
export MUSTER_TOWN_DATA="${MUSTER_TOWN_DATA:-$STATE/data}"
export MUSTER_TOWN_EXPORT="${MUSTER_TOWN_EXPORT:-$STATE/export}"
mkdir -p /data "$STATE"

if [ ! -d "$REPO/.git" ]; then
  echo "[entrypoint] first boot: copying the baked checkout to $REPO"
  rm -rf "$REPO" # a copy interrupted on an earlier boot leaves a partial one
  cp -a /opt/seed "$REPO"
fi
cd "$REPO"

# a town deployed when the state still lived inside the checkout: move it out once (same volume, so a rename, not a copy)
if [ ! -e "$MUSTER_TOWN_DATA" ] && [ -d "$REPO/$COLLECTIVE/data" ]; then
  echo "[entrypoint] moving $COLLECTIVE/data out of the checkout to $MUSTER_TOWN_DATA"
  mkdir -p "$(dirname "$MUSTER_TOWN_DATA")"
  mv "$REPO/$COLLECTIVE/data" "$MUSTER_TOWN_DATA"
fi
if [ ! -e "$MUSTER_TOWN_EXPORT" ] && [ -d "$REPO/$COLLECTIVE/export" ]; then
  echo "[entrypoint] moving $COLLECTIVE/export out of the checkout to $MUSTER_TOWN_EXPORT"
  mkdir -p "$(dirname "$MUSTER_TOWN_EXPORT")"
  mv "$REPO/$COLLECTIVE/export" "$MUSTER_TOWN_EXPORT"
fi

# commit identity for the export and the redeploy's rebase
export GIT_AUTHOR_NAME="Muster Town" GIT_AUTHOR_EMAIL="town@muster.town" GIT_COMMITTER_NAME="Muster Town" GIT_COMMITTER_EMAIL="town@muster.town"

# GitHub access for pull/redeploy: a host GH_TOKEN (Fly secret) becomes a credential helper here; it is never written to disk.
# Without one, the server adds the collective's GH_TOKEN secret (Town Hall) to its git commands itself.
git remote set-url origin "https://github.com/mitchellgordon95/agent-town.git"
if [ -n "${GH_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
fi

# a migrated town: upload RESTORE.tgz (data/ with town.db, admin-token, session-secret; export/) to /data and restart the Machine.
# The tarball is unpacked and checked first; the state it replaces is kept beside the new one, never deleted.
if [ -f /data/RESTORE.tgz ]; then
  stamp="$(date +%Y%m%d%H%M%S)"
  tmp="/data/restore-$stamp"
  echo "[entrypoint] restoring the town from /data/RESTORE.tgz"
  mkdir -p "$tmp"
  if tar -xzf /data/RESTORE.tgz -C "$tmp" && [ -f "$tmp/data/town.db" ]; then
    if [ -e "$MUSTER_TOWN_DATA" ]; then mv "$MUSTER_TOWN_DATA" "$STATE/data.replaced-$stamp"; fi
    if [ -e "$MUSTER_TOWN_EXPORT" ]; then mv "$MUSTER_TOWN_EXPORT" "$STATE/export.replaced-$stamp"; fi
    mkdir -p "$(dirname "$MUSTER_TOWN_DATA")" "$(dirname "$MUSTER_TOWN_EXPORT")"
    mv "$tmp/data" "$MUSTER_TOWN_DATA"
    if [ -d "$tmp/export" ]; then mv "$tmp/export" "$MUSTER_TOWN_EXPORT"; fi
    rm -rf "$tmp"
    mv /data/RESTORE.tgz "/data/RESTORE.done-$stamp.tgz"
    echo "[entrypoint] restored; the previous state is in $STATE/*.replaced-$stamp"
  else
    echo "[entrypoint] RESTORE.tgz is not a tarball with data/town.db in it; the town keeps its current state"
    rm -rf "$tmp"
    mv /data/RESTORE.tgz "/data/RESTORE.bad-$stamp.tgz"
  fi
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
