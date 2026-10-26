#!/bin/sh
# Deploy the town image to Fly from a throwaway clone of GitHub main, with the build-context fixes Fly needs:
#  - the repo's .dockerignore (made for the desk image) excludes .git and collectives/, so it is replaced by deploy/fly/dockerignore;
#  - Fly's upload drops `.git`, so it travels as `gitdir` (the Dockerfile moves it back).
# Usage: deploy/fly/build.sh [app] [extra `fly deploy` flags...]      (needs flyctl logged in, and access to GitHub)
#   REPO_URL (default git@github.com:mitchellgordon95/agent-town.git; a desk uses https://x-access-token:$GH_TOKEN@github.com/...)
#   BRANCH   (default main)
# This only (re)builds the image. The live checkout is on the volume (/data/repo) and moves with the town's own `redeploy`;
# to take a new image's checkout, delete /data/repo (fly ssh console -a muster-town -C "rm -rf /data/repo") and restart the Machine.
set -eu
APP="${1:-muster-town}"
[ $# -gt 0 ] && shift
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
git clone -q --branch "${BRANCH:-main}" "${REPO_URL:-git@github.com:mitchellgordon95/agent-town.git}" "$DIR"
cd "$DIR"
# a token in REPO_URL must not be baked into the image: the seed remote is the plain URL (entrypoint.sh sets it again at boot)
git remote set-url origin "https://github.com/mitchellgordon95/agent-town.git"
mv .git gitdir
cp deploy/fly/dockerignore .dockerignore
fly deploy --ha=false -c fly.town.toml -a "$APP" "$@"
