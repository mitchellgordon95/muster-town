# Muster Town desk image: one persistent sandbox per resident.
# Build from the repo root:  npm run desk:build
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# git, python3, gh (official apt repo)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git procps curl ca-certificates python3 python3-pip python3-venv \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# headless Chromium for browser checks of the web UI. Debian's package works on amd64 and arm64
# and pulls in the shared libs (libnspr4, libnss3, libgbm1, ...) that Playwright's own downloaded
# browsers also need, so `npx playwright` works too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# scientific Python for research desks
RUN pip3 install --no-cache-dir --break-system-packages numpy pandas xarray netCDF4 scipy matplotlib requests

# Claude Code CLI (the SDK also ships its own binary; this one is for humans exec'ing into a desk)
RUN npm i -g @anthropic-ai/claude-code && npm cache clean --force

# the desk package (+ schema) as a tiny workspace
WORKDIR /opt/agent-town
RUN printf '%s\n' '{ "name": "agent-town-desk-image", "private": true, "type": "module", "workspaces": ["packages/schema", "packages/desk"] }' > package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/desk/package.json packages/desk/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages/schema/src packages/schema/src
COPY packages/desk/src packages/desk/src
RUN printf '%s\n' '#!/bin/sh' 'exec node --import file:///opt/agent-town/node_modules/tsx/dist/esm/index.mjs /opt/agent-town/packages/desk/src/cli.ts "$@"' > /usr/local/bin/agent-town-desk \
 && chmod 755 /usr/local/bin/agent-town-desk

# non-root user `agent` (uid 1000): the base image's `node` user, renamed
RUN groupmod -n agent node \
 && usermod -l agent -d /home/agent -m node \
 && mkdir -p /home/agent/work \
 && chown -R agent:agent /home/agent

USER agent
WORKDIR /home/agent
VOLUME /home/agent
CMD ["sleep", "infinity"]
