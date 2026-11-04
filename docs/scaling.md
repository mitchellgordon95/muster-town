# Scaling muster.town: ceilings, triggers and the path past them

One Machine serves muster.town (`muster-town`, `performance-1x`, 2 GB, region `iad`, 10 GB volume; see deploy/README.md
"Prod on Fly.io"). SQLite is a single writer, so the town cannot simply add Machines. This page lists every resource we know
runs out first, what it ran out at when measured, what it reads live, the number at which we act, and the fixes in the order
we would make them. Written for grant gr_n0p3ast5pp (key result kr_i5d6a7t62b); the measurements come from the stress grant
gr_wqnunw5yd8 (closed 10-27) and the tick benchmark of 11-02.

Town doc ids (`dc_…`) open at `https://muster.town/workshop/#/doc/<id>`.

## Resources

Live values: `GET https://muster.town/api/health` at 2026-11-02T03:13:27Z (server `time`), commit fbdec57, unless a cell says otherwise.

| # | Resource | Measured ceiling (source) | Live value now | Trigger to act | Next fix (in order) | Then scale-out |
|---|---|---|---|---|---|---|
| 1 | WebSocket egress (network path) | about 20–25 MB/s total, where the viewer ramps flattened (stress runs 3 and 4, dc_jea12u6sal; rollup dc_eldvky6svj) | not measured live; 1 WS client, so near 0 | 10 MB/s sustained (half the ceiling), or `wsClients` ≥ 600 | 1. stringify once per change: done 11-04 (gr_n0p3ast5pp step 4, below); 2. coalesce walker moves into one frame per tick; 3. smaller snapshot (23.4 KB at 13 walkers) | read replicas serving viewers (below) |
| 2 | WebSocket per-viewer fanout (main thread) | 1,200 viewers sustained, 1,600 marginal, 2,000 fail (dc_eldvky6svj, page dc_258ct4a96c); on a desk, one change costs the main thread 20.7 ms of wall time (10.5 ms CPU) at 1,000 sockets after stringify-once, 25.2 ms (12.7 ms) before (table below) | `wsClients` 1 | `wsClients` ≥ 600 (50 % of 1,200) | 1. stringify-once in packages/server/src/ws.ts: done 11-04 (step 4, kr_vc8rkafulk); 2. re-run the viewer ramp on a throwaway to get the new ceiling; 3. pre-frame one buffer per change (ws `Sender.frame`) only if the fanout row fires: it bypasses the library's per-socket queue | read replicas for viewers |
| 3 | Runtime tick (main thread, every 5 s) | `SLOW_TICK_MS` = 500 ms (packages/runtime/src/index.ts). Desk p95 163 / 473 / 1,841 ms at 1× / 2× / 4× world size; live p95 crosses 500 ms at about 1.5× today's world (range 1.2–1.8×) (dc_er6dxw6kil) | last tick 138 ms; slowest recent 635 ms (03:12:18Z, explore 172 ms, work 243 ms). Earlier samples 154–291 ms (dc_dij54lgnuk, dc_er6dxw6kil) | tick p95 ≥ 350 ms over 100 ticks (70 % of 500), or world size ≥ 1.2× today (≥ 120k events, ≥ 10 buildings) | 1. cache `Bank.expectedSession` per tick (or a rolling aggregate); 2. sum Bank debits once per tick, not per funding candidate; 3. memoize free tokens per tick in `exploreTick` (all from the step 1 profile, dc_er6dxw6kil). Runtime code is the Workshop's: Prod measures, the fix goes through them | bigger Machine does not help a single thread much; next is moving the tick off the main thread (worker), not built |
| 4 | Restarts (every one drops all WebSockets) | each restart 2.8–3.8 s; 35 in 4 h 11 min on 10-31/11-01 (dc_dij54lgnuk); outside pollers saw 2 timeouts in one (dc_2ns1jgf0fu) | 15 "Redeploy finished" events in the 24 h before 03:13Z 11-02 (events 96,125–100,995), mostly two bursts (21:23–22:29Z and 02:24–03:07Z) | > 10 restarts in 24 h. **Firing now (15).** | 1. coalesced CI redeploy and the prebuilt server (page dc_eka5xluv6o, PR #230 live); 2. drain without throwing away sessions (grant gr_w9ue1k1p0c); 3. clients reconnect without a full snapshot (not started) | a second Machine for zero-downtime deploys needs replicas first |
| 5 | Database and volume growth | volume 10 GB (deploy/recover.sh default "like the live one"); the monitor's `disk` metric is yellow under 25 % free, red under 10 % | backup `bytes` 44,505,918 (44.5 MB) at 03:00Z 11-02. Growth: 40.0 MB (00:00Z 11-01, dc_ovwbrarmw8) → 44.5 MB in 27 h, about 0.17 MB/h (two points; dc_dij54lgnuk's 0.9 MB/h came from 2 h of one busy night). At this rate 10 GB lasts years | db ≥ 1,000 MB, or volume free < 50 % | 1. prune old `events` and `agent.tool`/`agent.thought` rows into the export (not built); 2. `VACUUM` after the prune; 3. grow the volume (`fly volumes extend`, $0.15/GB-month) | — |
| 6 | Hourly backup and export vs db size | backup is a SQLite snapshot plus gzip, encrypted, uploaded and re-downloaded to verify (grant gr_ba0juhlm7n); the git export runs in a worker since 9484ad6 (PR #235): desk loop block 2.1–3.2 s → max gap 17–18 ms (dc_4ouqa4mlh1, page dc_yotozpmakq). No measured ceiling | backup `lastAt` = `verifiedAt` 03:00:10.964Z, so the run took about 11 s after the hour mark for 44.5 MB; `error` null. Export: one export.done per hour, ~2,045 files (dc_8kz3scjc33); its git commit fails on Fly since 10-29 (fix 45be606 live 03:07Z, unverified) | backup `lastAt` more than 300 s after the hour, or > 70 min old (the monitor's `backup` rule is yellow at 2 h, red at 6 h) | 1. move the backup snapshot+gzip into the same worker as the export; 2. incremental export (only changed docs) | — |
| 7 | Desk slots and the desk bill | `desks.maxRunning` (stored 6 on 10-27, default 30; page dc_sklwrtgfo8) and the $10/day desk bill cap (`desks.billCapUsd`) | `desks.billTodayUsd` $0.13 of $10 (1.3 %), size `performance-1x`; slots in use are not in public health (unverified now) | bill ≥ 80 % of the cap on 3 days in a week, or the monitor's `slots` metric yellow (≥ 80 % in use for 15 min) | 1. raise `maxRunning` (Planning → System → Session slots) after checking the host's lag; 2. raise the bill cap (Mitchell's call: it is money); 3. cheaper desk size for light work | desks already run on their own Machines; this resource scales by money, not by architecture |
| 8 | Memory (RSS) | 2 GB Machine; monitor yellow > 1,229 MB (1.2 GB), red > 1,638 MB (packages/server/src/monitor.ts). Stress peak with 160 agents: 186 MB (dc_258ct4a96c) | `rssMb` 302 | RSS ≥ 1,000 MB for a day | 1. find the holder with a heap snapshot | perf-2x (4 GB) |

The stress ceilings (rows 1 and 2) were measured on a clone of the Machine when it was `shared-cpu-2x`. It moved to
`performance-1x` (a dedicated core) on 10-31 after the CPU-throttle incident (docs/postmortem-2026-10-31-cpu-throttle-503.md),
so the viewer ceiling is probably higher now; that is not measured. Load never goes to muster.town itself: re-measure on a
throwaway (`deploy/fly/throwaway.sh`, `scripts/stress/viewers.mjs`).

## WebSocket fanout: stringify once (step 4, 2026-11-04)

Before 11-04, `packages/server/src/ws.ts` subscribed every socket to `world.changes` itself, so one change was
`JSON.stringify`-ed once per viewer. Now one subscription per server stringifies a change once and hands the same string
to every streaming socket; the per-socket `readyState` and "too slow" (`bufferedAmount` > 8 MB → close 1013) checks stay,
and the snapshot and error frames stay per socket (they differ). Test: packages/server/test/live.test.ts "a change reaching
N sockets is stringified once".

Measured on a desk (1 vCPU, 2 GB, Node 22, the server with `MUSTER_TOWN_RUNTIME=off` plus 8 scripted walkers; load never goes
to muster.town): `scripts/stress/viewers.mjs --steps 1000 --hold 60 --procs 4 --walkers 8`, three 60 s holds each way, medians.
"ms per change" is main-thread time inside the `world.changes` fan-out (a temporary timer around the emitter, not committed);
the 4 client processes share the one core with the server, so wall time includes their preemption and the CPU column is the
cleaner figure. Event-loop lag is health `load.lagMs` (p99 over 1 s samples), its p50 and max over the hold.

| | before (per-socket stringify) | after (stringify once) | change |
|---|---|---|---|
| ms per change at 1,000 sockets, wall | 25.2 (24.2–25.7) | 20.7 (20.6–21.7) | −18 % |
| ms per change at 1,000 sockets, CPU | 12.7 (12.1–12.7) | 10.5 (10.3–11.0) | −17 % |
| event-loop lag p50 / max, ms | 111 / 132 | 85 / 107 | −23 % / −19 % |
| egress, kB/s per client (× 1,000) | 6.9 | 7.0 | same |
| clients dropped (1013) / errors | 0 / 0 | 0 / 0 | same |

So the stringify was about a fifth of the fan-out; the rest is the `ws` library framing and writing each socket (about 10 µs
per socket per change). The next cut there is pre-framing (row 2, fix 3), worth doing only when the row fires.

## Tick time vs world size

From the tick benchmark note dc_er6dxw6kil (desk, local SQLite worlds seeded at k× the live size of 11-02: 8 buildings,
19 agents, ~100k events, ~2,000 docs, ~1,050 work sessions in 7 days; 30 measured ticks each, commit fbdec57):

| world size | tick p50 (ms) | tick p95 (ms) | tick max (ms) | work p95 | explore p95 | streams p95 |
|---|---|---|---|---|---|---|
| 1× | 125 | 163 | 175 | 26 | 54 | 93 |
| 2× | 369 | 473 | 482 | 120 | 130 | 204 |
| 4× | 1,685 | 1,841 | 1,971 | 1,039 | 480 | 369 |

- Growth is close to quadratic: p95 ≈ 163·k^1.75 ms on the desk, local exponent 1.54 (1×→2×) and 1.96 (2×→4×).
- Desk p95 crosses 500 ms at about 2.1× (±0.2×). Live ticks run about 1.7× slower than the desk (ratio 0.43–0.81), so
  **live p95 crosses 500 ms at about 1.5× today's world (range 1.2–1.8×)**.
- Biases: the bench ran 37–97 sessions at once against ~7 live, which inflates `work` at 2× and 4× (the 4× work figure is an
  upper bound), and its session history is denser than live, which inflates `streams` about 2×. Hosted towns, viewers and
  meetings were not scaled.

## Scale-out options (written only, not built)

Nothing here is built in grant gr_n0p3ast5pp. Prices: Fly.io `iad`, per Machine-hour, as given in the grant plan
(dc_dij54lgnuk); a month is 730 h. Check fly.io/docs/about/pricing before spending.

| Option | When its trigger fires | What it costs | What it does not fix |
|---|---|---|---|
| **Bigger Machine.** Today `performance-1x` ($0.0458/h, about $33/month); `performance-2x` is $0.0917/h (about $67/month, 2 dedicated cores, 4 GB). `shared-cpu-2x` ($0.0186/h, about $14/month) is what the town ran on until 10-31, when CPU throttling caused 503s | RSS ≥ 1,000 MB (row 8), or event-loop lag p99 > 200 ms (monitor `lag` yellow) while the tick and fanout fixes are already in | +$34/month for perf-2x; one restart to resize (`fly scale vm`) | Node runs the tick and the WS fanout on one thread: a second core helps only workers (export, backup) and GC. It buys little for rows 2 and 3 |
| **Read replicas (LiteFS).** The primary keeps the single SQLite writer; replicas get the database streamed to them and serve viewers' WebSockets and GETs; writes are forwarded to the primary. Fly's hosted LiteFS Cloud backup service has been shut down; the open-source LiteFS layer itself still exists. Check its support status before choosing it | `wsClients` ≥ 1,000 after stringify-once (row 2), or WS egress ≥ 15 MB/s (row 1) | one more Machine per replica: about $14/month (shared-cpu-2x) to $33/month (perf-1x), plus its volume ($0.15/GB-month); work to route writes and WS changes through the primary | the tick (row 3) still runs on the primary only |
| **One hosted town per Machine.** Today hosted collectives run in the same process as muster.town (`hosted.count` 2, docs/hosted-collectives.md). Each could run as its own app with its own volume, with muster.town as the directory and sign-in front | hosted towns ≥ 10, or a hosted town's traffic shows in muster.town's tick or lag | about $14/month (shared-cpu-2x) per town plus about $0.15/GB-month of volume; a hosted town that is idle can be auto-stopped | muster.town's own tick and viewers |

## How to check headroom live

`GET https://muster.town/api/health` carries a `capacity` block (gr_n0p3ast5pp step 3, kr_mbuhs8agz7; packages/server/src/capacity.ts),
recomputed every 5 s with the other cached figures (`capacity.at` says when). These are its numbers, matching the triggers above:

| capacity field | value | ceiling | trigger |
|---|---|---|---|
| `wsClients.now` / `wsClients.ceiling` | live WebSocket count (root app) | 1,200 viewers (row 2) | ≥ 600 |
| `tick.p95Ms` / `tick.slowMs` / `tick.samples` | p95 of the main world's last 100 distinct tick `ms` (hosted worlds not included) | 500 ms (`SLOW_TICK_MS`) | ≥ 350 ms |
| `db.mb` / `db.volumeGb` | town.db + -wal size in MB / the data volume size in GB | 10 GB volume | db ≥ 1,000 MB or volume free < 50 % |
| `restarts24h` | server starts in the last 24 h (one `system` event with `payload.boot` per start) | — | > 10 |

`curl -s https://muster.town/api/health | jq .capacity`. The tick ring and the restart count start fresh at each boot from
memory and the events table: `tick.samples` is below 100 for the first ~17 min after a restart.

