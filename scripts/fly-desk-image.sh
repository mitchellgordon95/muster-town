#!/usr/bin/env bash
# Build the desk image on Fly's remote builder and push it to registry.fly.io/$FLY_APP:desk (fly.desk.toml).
# Run from the repo root with FLY_ACCESS_TOKEN = a deploy token for the desk app. The town's `redeploy` with the desk image runs it
# on a Fly host, with the host secret FLY_DESKS_ACCESS_TOKEN as that token. Installs flyctl when it isn't on PATH
# (into $FLYCTL_INSTALL: /data/flyctl on the town's volume, else ~/.fly), since the town server's image doesn't ship it.
set -euo pipefail
: "${FLY_ACCESS_TOKEN:?set FLY_ACCESS_TOKEN to the desk app's deploy token}"
app="${FLY_APP:-muster-desks}"
fly="$(command -v flyctl || command -v fly || true)"
if [ -z "$fly" ]; then
  if [ -z "${FLYCTL_INSTALL:-}" ]; then
    if [ -d /data ] && [ -w /data ]; then FLYCTL_INSTALL=/data/flyctl; else FLYCTL_INSTALL="$HOME/.fly"; fi
  fi
  export FLYCTL_INSTALL
  if [ ! -x "$FLYCTL_INSTALL/bin/flyctl" ]; then
    echo "installing flyctl into $FLYCTL_INSTALL"
    curl -fsSL https://fly.io/install.sh | sh >/dev/null
  fi
  fly="$FLYCTL_INSTALL/bin/flyctl"
fi
"$fly" version
exec "$fly" deploy --build-only --push --remote-only --image-label desk -c fly.desk.toml -a "$app"
