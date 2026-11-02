#!/usr/bin/env bash
# Onboarding lag (grant gr_mjr7nb438v, KR kr_hee2pa2d5r): how long the oldest change on main that a reader of the
# onboarding material could notice has gone unswept. One line:
#   Lag: N h (checked-through <sha>, oldest unswept <sha> at <time>)
# N = hours from the oldest unswept reader-visible commit until now; 0 when nothing is unswept. A commit's time is its
# committer time, but never earlier than the checked-through sha's (a branch commit made before it can't be older news).
# Reader-visible paths are those of Onboarding's since.sh (skill dc_kzuf6rx4la), tests excluded; docs/log.md is history.
# Usage: scripts/onboarding-lag.sh <checked-through sha> [repo dir]
#   The checked-through sha is on topic page dc_t4jw2xcwut ("Onboarding lag (gr_mjr7nb438v)"). NOW=<epoch s> overrides the clock.
set -euo pipefail
base="${1:?usage: scripts/onboarding-lag.sh <checked-through sha from dc_t4jw2xcwut> [repo dir]}"
cd "${2:-$(dirname "$0")/..}"
git fetch -q origin main
git rev-parse -q --verify "$base^{commit}" >/dev/null || { echo "unknown sha: $base" >&2; exit 1; }
git merge-base --is-ancestor "$base" origin/main || { echo "$base is not on origin/main" >&2; exit 1; }
PATHS=(README.md docs CLAUDE.md AGENTS.md skills/muster-town packages/web/src packages/server/src/routes packages/server/src/home.ts
  ':(exclude)docs/log.md' ':(exclude)*.test.ts' ':(exclude)*.test.tsx')
short=$(git rev-parse --short "$base")
floor=$(git log -1 --format=%ct "$base")
oldest=$(git log --no-merges --format='%h %ct' "$base"..origin/main -- "${PATHS[@]}" |
  awk -v f="$floor" '{ t = $2 < f ? f : $2; if (min == "" || t <= min) { min = t; h = $1 } } END { if (h != "") print h, min }')
if [[ -z "$oldest" ]]; then
  echo "Lag: 0 h (checked-through $short, oldest unswept none: main $(git rev-parse --short origin/main) has no reader-visible change since)"
  exit 0
fi
read -r sha ts <<<"$oldest"
now="${NOW:-$(date +%s)}"
hours=$(awk -v s=$((now - ts)) 'BEGIN { printf "%.1f", s / 3600 }')
echo "Lag: $hours h (checked-through $short, oldest unswept $sha at $(date -u -d "@$ts" +%Y-%m-%dT%H:%M:%SZ))"
