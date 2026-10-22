#!/bin/sh
# Deploy the town image to Fly from a throwaway clone of GitHub main, with the build-context fixes Fly needs:
#  - the repo's .dockerignore (made for the desk image) excludes .git and collectives/, so it is replaced by deploy/fly/dockerignore;
#  - Fly's upload drops `.git`, so it travels as `gitdir` (the Dockerfile moves it back).
# Usage: deploy/fly/build.sh [app]      (needs flyctl logged in, and SSH access to GitHub)
# This only (re)builds the image. The live checkout is on the volume (/data/repo) and moves with the town's own `redeploy`;
# to take a new image's checkout, delete /data/repo (fly ssh console -a muster-town -C "rm -rf /data/repo") and restart the Machine.
set -eu
APP="${1:-muster-town}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
git clone -q --branch main git@github.com:mitchellgordon95/agent-town.git "$DIR"
cd "$DIR"
mv .git gitdir
cp deploy/fly/dockerignore .dockerignore
fly deploy --ha=false -c fly.town.toml -a "$APP"
