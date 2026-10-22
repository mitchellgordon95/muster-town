# The town server on Fly.io (one Machine, a volume at /data). Build from a clean clone of main (it bakes the checkout, .git included):
#   fly deploy --ha=false -c fly.town.toml
# The image is only the first-boot seed and the runtime (node, git, build tools). The live checkout lives on the volume at /data/repo
# and moves with the town's own `redeploy` (git pull, install, build, exit 75; entrypoint.sh restarts the server), not with `fly deploy`.
FROM node:22-bookworm-slim

# git (pull/export), build tools (native modules), sqlite3 (backups), ca-certificates + curl (health checks, tooling)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential sqlite3 openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/seed
COPY . .
RUN npm ci --no-audit --no-fund && npm run build \
 && rm -rf /root/.npm

COPY deploy/fly/entrypoint.sh /usr/local/bin/town-entrypoint
RUN chmod 755 /usr/local/bin/town-entrypoint

ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/town-entrypoint"]
