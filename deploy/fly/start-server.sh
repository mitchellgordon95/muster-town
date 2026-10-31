#!/bin/sh
# Starts the town server once, from the checkout's root; deploy/fly/entrypoint.sh calls it at every (re)start and restarts it on exit 75.
# It lives in the checkout, not the image, so a redeploy changes how the server starts without an image deploy.
#
# The server runs prebuilt (packages/server/build.mjs; docs/postmortem-2026-10-31-cpu-throttle-503.md suggestion 6): node on
# packages/server/dist uses about a third of tsx's CPU per boot. dist/BUILD_HEAD names the commit it was built from; the redeploy
# builds it before its drain, so it normally matches HEAD. When it doesn't (the image's first-boot seed, a checkout moved by hand),
# it is built here; if that fails the sources run with tsx as before, so a broken bundle can't keep the town down.
set -u
BUNDLE=packages/server/dist/main.js
current() { [ -f "$BUNDLE" ] && [ "$(cat packages/server/dist/BUILD_HEAD 2>/dev/null)" = "$(git rev-parse HEAD 2>/dev/null)" ]; }
if ! current; then
  echo "[start-server] building the server bundle"
  node packages/server/build.mjs || echo "[start-server] server bundle build failed; starting the sources with tsx"
fi
if current; then exec node "$BUNDLE"; fi
exec npx tsx packages/server/src/main.ts
