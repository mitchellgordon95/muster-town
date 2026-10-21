#!/usr/bin/env bash
# One-time (idempotent) setup of the prod box (Ubuntu 24.04, x86_64) for Muster Town. Run as root:
#   sudo bash deploy/bootstrap.sh
# Re-running is safe: every step checks before it acts. See deploy/README.md for what comes before and after.
set -euo pipefail

REPO_SSH="${REPO_SSH:-git@github.com:mitchellgordon95/agent-town.git}"
DIR=/srv/muster-town
BRANCH="${BRANCH:-prod}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say() { echo "[bootstrap] $*"; }
as_muster() { sudo -u muster -H bash -lc "cd $DIR && $*"; }

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }

# 1. swap: a cushion under 6 desks (stress test dc_vxgg8r55ha: 8 compiling desks left 0.1 GB free)
if ! swapon --show | grep -q /swapfile; then
  say "adding 4 GB swap"
  [[ -f /swapfile ]] || { fallocate -l 4G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-muster-swap.conf
fi

# 2. packages: node 22, caddy, gh, sqlite3 (docker is expected already; install it with get.docker.com if not)
command -v docker >/dev/null || { echo "docker is missing: curl -fsSL https://get.docker.com | sh" >&2; exit 1; }
apt-get update -qq
apt-get install -y -qq git sqlite3 curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  say "installing node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  say "installing caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
if ! command -v gh >/dev/null; then
  say "installing gh"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

# 3. the service user (owns the checkout and the data; may drive docker for desks)
id muster >/dev/null 2>&1 || { say "creating user muster"; useradd --create-home --shell /bin/bash muster; }
usermod -aG docker muster

# 4. read-only deploy key for the private repo; stop here until it is added on GitHub
KEY=/home/muster/.ssh/id_ed25519
if [[ ! -f $KEY ]]; then
  sudo -u muster -H bash -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -q -t ed25519 -N '' -C muster-prod-1-deploy -f $KEY && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null"
fi
if ! sudo -u muster -H git ls-remote "$REPO_SSH" HEAD >/dev/null 2>&1; then
  say "add this key as a READ-ONLY deploy key (repo Settings > Deploy keys), then re-run:"
  cat "$KEY.pub"
  exit 3
fi

# 5. checkout on the deploy branch (falls back to main until CI has created `prod`)
mkdir -p "$DIR" && chown muster:muster "$DIR"
[[ -d $DIR/.git ]] || { say "cloning into $DIR"; sudo -u muster -H git clone -q "$REPO_SSH" "$DIR"; }
if sudo -u muster -H git -C "$DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null; then
  sudo -u muster -H git -C "$DIR" fetch -q origin "$BRANCH"
  sudo -u muster -H git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  say "no origin/$BRANCH yet: staying on main (set MUSTER_TOWN_DEPLOY_BRANCH=main in the unit until CI creates it)"
fi
say "installing deps, building web and the desk image (slow the first time)"
as_muster "npm ci --no-audit --no-fund >/dev/null && npm run build --workspace packages/web >/dev/null"
as_muster "docker build -q -t muster-town-desk -t agent-town-desk -f packages/desk/Dockerfile . >/dev/null"

# 6. desks reach the town over docker0; 4322 stays closed to the internet (the server is a host process)
ufw status | grep -q '4322/tcp on docker0' || ufw allow in on docker0 to any port 4322 proto tcp

# 7. secrets file (Mitchell fills it over SSH; never through an agent): root-owned, systemd reads it
install -d -m 700 /etc/muster-town
[[ -f /etc/muster-town/env ]] || install -m 600 /dev/null /etc/muster-town/env

# 8. nightly local backup of the world (Litestream comes later, after secrets are encrypted at rest)
install -d -o muster -g muster -m 700 /var/backups/muster-town
cat > /etc/cron.d/muster-town-backup <<EOF
# nightly sqlite backup of the Workshop world, keep 14 days
17 4 * * * muster sqlite3 $DIR/collectives/workshop/data/town.db ".backup /var/backups/muster-town/town-\$(date +\\%F).db" && find /var/backups/muster-town -name 'town-*.db' -mtime +14 -delete
EOF

# 9. service + Caddy
install -m 644 "$SRC/muster-town.service" /etc/systemd/system/muster-town.service
install -m 644 "$SRC/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable -q --now muster-town
systemctl reload caddy || systemctl restart caddy
say "done. Next: fill /etc/muster-town/env, systemctl restart muster-town, then set maxRunning 6 (deploy/README.md)"
