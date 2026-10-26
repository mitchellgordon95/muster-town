#!/bin/sh
# A throwaway clone of the town for load tests (grant gr_wqnunw5yd8): Fly app `muster-town-stress`, the same image (deploy/fly/Dockerfile,
# built from GitHub main) and the same size as muster-town (fly.town.toml: shared-cpu-2x / 2 GB, iad, a 10 GB volume), booted fresh:
# no copy of the live state, none of the live secrets (no Claude token, no GitHub OAuth, no repo token, no FLY_API_TOKEN), so it can
# neither start desks nor spend tokens. Its only secret is a random MUSTER_TOWN_DATA_KEY of its own.
#
# Usage: FLY_STRESS_TOKEN=... deploy/fly/throwaway.sh [create|status|admin-token|destroy|--destroy]
#   create (default)  app + volume + data key, build and deploy the image, wait for /api/health, fetch the admin token
#   status            Machine status and /api/health
#   admin-token       print the throwaway's admin token (its data dir, over fly ssh) and save it to $STRESS_DIR/admin-token
#   destroy           delete the app (Machines and volume included)
# FLY_STRESS_TOKEN is the token Mitchell made for this (a Town Hall secret granted to the Prod); the real FLY_API_TOKEN (the desks
# app's deploy token) is never used here and never put on the throwaway. STRESS_DIR (default ~/.muster-stress) keeps the token file.
set -eu
APP="muster-town-stress"
REGION="iad"
HOST="$APP.fly.dev"
STRESS_DIR="${STRESS_DIR:-$HOME/.muster-stress}"
FLY="${FLY:-fly}"
command -v "$FLY" >/dev/null 2>&1 || FLY=flyctl
command -v "$FLY" >/dev/null 2>&1 || { echo "flyctl not found (curl -L https://fly.io/install.sh | sh)"; exit 1; }
: "${FLY_STRESS_TOKEN:?set FLY_STRESS_TOKEN (the throwaway's Fly token; never the real FLY_API_TOKEN)}"
export FLY_API_TOKEN="$FLY_STRESS_TOKEN"
# belt and braces: this script only ever touches the throwaway
case "$APP" in muster-town|muster-desks) echo "refusing to touch $APP"; exit 2;; esac

cmd="${1:-create}"
health() { curl -s -m 10 "https://$HOST/api/health"; }
fetch_admin_token() {
  mkdir -p "$STRESS_DIR"
  umask 077
  "$FLY" ssh console -a "$APP" -C "cat /data/workshop/data/admin-token" | tr -d '\r' | grep -E '^at_' > "$STRESS_DIR/admin-token.tmp"
  mv "$STRESS_DIR/admin-token.tmp" "$STRESS_DIR/admin-token"
  echo "admin token saved to $STRESS_DIR/admin-token (export STRESS_ADMIN_TOKEN=\$(cat $STRESS_DIR/admin-token))"
}

case "$cmd" in
  create)
    if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
      echo "[throwaway] creating app $APP"
      "$FLY" apps create "$APP" --org "${FLY_ORG:-personal}"
    fi
    if ! "$FLY" volumes list -a "$APP" 2>/dev/null | grep -q "town_data"; then
      echo "[throwaway] creating volume town_data (10 GB, $REGION)"
      "$FLY" volumes create town_data -a "$APP" -r "$REGION" -s 10 --yes
    fi
    if ! "$FLY" secrets list -a "$APP" 2>/dev/null | grep -q "MUSTER_TOWN_DATA_KEY"; then
      echo "[throwaway] setting a fresh MUSTER_TOWN_DATA_KEY (the throwaway's only secret)"
      "$FLY" secrets set -a "$APP" --stage "MUSTER_TOWN_DATA_KEY=$(openssl rand -base64 32)"
    fi
    echo "[throwaway] building the image from GitHub ${BRANCH:-main} and deploying (same Dockerfile, size and region as muster-town)"
    # env overrides of fly.town.toml: its own public URL; desks pointed at a docker backend the Machine does not have, so a session
    # start fails at once instead of reaching Fly (maxRunning must be >= 1); no desks app
    REPO_URL="${REPO_URL:-https://x-access-token:${GH_TOKEN:?GH_TOKEN (repo read) is needed to clone the private repo}@github.com/mitchellgordon95/agent-town.git}" \
      "$(dirname "$0")/build.sh" "$APP" --yes --regions "$REGION" \
        --env "MUSTER_TOWN_PUBLIC_URL=https://$HOST" \
        --env 'MUSTER_TOWN_DESKS={"backend":"docker","maxRunning":1}' \
        --env "FLY_APP=none"
    echo "[throwaway] waiting for https://$HOST/api/health"
    i=0
    until health | grep -q '"ok":true'; do
      i=$((i + 1)); [ "$i" -gt 90 ] && { echo "[throwaway] health never came up"; "$FLY" status -a "$APP"; exit 1; }
      sleep 5
    done
    echo "[throwaway] up: $(health)"
    fetch_admin_token
    ;;
  status)
    "$FLY" status -a "$APP"
    health; echo
    ;;
  admin-token)
    fetch_admin_token
    ;;
  destroy|--destroy)
    echo "[throwaway] destroying app $APP (Machines and volume)"
    "$FLY" apps destroy "$APP" --yes
    rm -f "$STRESS_DIR/admin-token"
    ;;
  *)
    echo "usage: deploy/fly/throwaway.sh [create|status|admin-token|destroy]"; exit 2
    ;;
esac
