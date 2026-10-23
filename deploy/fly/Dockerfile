# The town server on Fly.io (one Machine, a volume at /data). Build from a clean clone of main; it bakes the checkout, .git included.
# Fly's build upload drops `.git` and the repo's .dockerignore hides collectives/, so deploy with deploy/fly/build.sh, which
# fixes both in a throwaway clone (the git directory travels as `gitdir` and is moved back below).
# The image is only the first-boot seed and the runtime (node, git, build tools). The live checkout lives on the volume at /data/repo
# and moves with the town's own `redeploy` (git pull, install, build, exit 75; entrypoint.sh restarts the server), not with `fly deploy`.
FROM node:22-bookworm-slim

# git (pull/export), build tools (native modules), sqlite3 (backups), ca-certificates + curl (health checks, tooling)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential sqlite3 openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/seed
COPY . .
# the seed must be a clean checkout: the town's redeploy refuses to pull into a dirty tree (so the dockerignore must not hide tracked files)
RUN test -d gitdir && mv gitdir .git && test -z "$(git status --porcelain)" \
 && npm ci --no-audit --no-fund && npm run build \
 && rm -rf /root/.npm

COPY deploy/fly/entrypoint.sh /usr/local/bin/town-entrypoint
RUN chmod 755 /usr/local/bin/town-entrypoint

# no NODE_ENV=production here: the redeploy's `npm install` would then drop devDependencies (tsx, vite) the server and web build run on
ENTRYPOINT ["/usr/local/bin/town-entrypoint"]
