# Post-mortem: muster.town answered 503 for ~20 minutes, then stayed slow (2026-10-31)

Author: Claude Code (Mitchell's session), 2026-10-31. Status: both fixes shipped the same evening (see "What changed");
the items under "Suggestions" are proposals for the workshop, ordered by how much of the next incident each one removes.

## What happened

All times UTC. The town ran on one Fly Machine, `shared-cpu-2x` (2 shared vCPUs, 2 GB), since the move to Fly on 10-22.

| time | event |
|---|---|
| 20:50 | Hourly off-site backups merge (fd2ec3e): copy, `integrity_check`, gzip, encrypt, upload, download and verify, all on the server's main thread. |
| 21:07 | The first hourly run processes the 76 MB `town.db`. The Machine's CPU burst balance, already low after ~40 CI redeploys that day (each a full `tsx` boot), runs out. |
| ~21:08 | Fly throttles the Machine to its baseline: about 12-14 % of one core. Inside the VM, `/proc/stat` shows a whole core of `steal` per second. The site was already "loading slowly" before this (Mitchell). |
| 21:22 | CI redeploys c457d92: the process restarts (exit 75) on the throttled CPU. Boot (tsx compile, migrations, waker replay) crawls; the event loop lags more than 8 s. |
| ~21:22 | `GET /api/health` no longer answers inside the check's 5 s. Fly marks the instance unhealthy and its proxy answers **503** ("no known healthy instances") to every request, desks' included. The process is alive and keeps logging slowly; Node's own `fetch` to GitHub and desks fails on timeouts ("fetch failed") while `curl` from the box works. |
| 21:27 | Mitchell reports the 503. |
| 21:39 | Mitchell resizes the Machine to `performance-1x` (one dedicated core): `fly machine update … --vm-size performance-1x`. Healthy at 21:40; every page 200. |
| 21:41-22:06 | Still slow: every route 2-5 s, a 726-byte `/api/finance` and plain 404s included, so requests were queuing behind synchronous work. The server held 65 % of the core, main thread runnable, reading the database at 15 MB/s. A 20 s CPU profile of the live process: 46 % idle, 15 % garbage collector, and 27.5 % under `Bank.debited`, which loaded every matching `bank_debits` row through the zod-parsing `Table.where` and summed in JavaScript, per live credit, per building, grant and lane, on every 5 s tick and every Bank or agents request. |
| 22:03 | Fix pushed (01220ca): `debited` sums in SQL. |
| 22:06:46 | Live. After: loop p99 stall 12-87 ms (was 1,000-2,400), routes 0.23-0.32 s (were 2-5), server at 7 % of the core, load average 0.23. |

Not a cause: memory (1.5 GB free throughout), disk, the database, the Machine's network, the desks, the single Claude CLI
child the manager session runs on the host (about 4 s of CPU in total). The town's per-tick `events` scans
(reconciliation, overdue forks, idle residents) read a lot of pages but cost milliseconds each.

Side effect: setting `[[vm]] size` in `fly.town.toml` left `main` red for a few minutes (the finance-fly test pins
`TOWN_MACHINE` to the file); a resident fixed the constant (346a186) before the Bank fix landed.

## Why

1. **A shared CPU with burst accounting, and nothing watching it.** Fly's shared vCPUs bank credit while idle and
   throttle to a small baseline once it is spent. The town sat near that line for days (the earlier slowness), and the
   first big burst tipped it. Nothing in the town or its monitor reads steal time or the CPU balance; the desks had met
   the same throttle (84-91 % steal, deploy/README.md) and moved to a dedicated core, the host had not.
2. **Heavy synchronous work on the one thread that serves HTTP.** The hourly backup (copy, integrity check, gzip,
   encrypt, verify), the hourly export (`JSON.parse` + zod over 82k events, then `git`), a full `tsx` compile at each
   boot and the waker's boot replay all block the event loop for seconds. ~40 merges a day means ~40 boots a day.
3. **An aggregate written as a row load.** `Bank.debited` was `SELECT *` + a zod parse per row + a JS sum. It is called
   in nested loops (credits × buildings, grants, lanes) from `canStart`, `freeTokensAll`, `laneBudgets`, `exploration`,
   `townBlocked` and `/api/bank`; its cost grew with the debit table (2,638 rows) and the number of callers, and the
   garbage it made is the 15 % GC. On a shared CPU that was most of the "slow before"; on the throttled one it was fatal.
4. **The health check turns slow into down.** `/api/health` with a 5 s timeout tells Fly to pull the only instance
   when the loop stalls; there is no degraded mode. A process restart (exit 75) runs under the live check, so the
   240 s `grace_period` (Machine start only) did not cover the redeploy's boot.
5. **No lag alert.** `/api/health` has carried `load.lagMs` (p99 loop stall per 10 s window) since 10-28 and nothing
   reads it; the monitor alerts on desk bills and sessions, not on the server's own responsiveness.

## What changed (shipped 2026-10-31)

- The town Machine is `performance-1x` (one dedicated core, 2 GB): `fly.town.toml` `[[vm]]`, `TOWN_MACHINE` in
  `packages/core/src/finance-fly.ts`, deploy/README.md. About $33/month instead of $13.
- `Bank.debited` sums in SQL (`Table.sum`), never loads the rows (`packages/core/src/bank.ts`).
- `deploy/fly/profile-live.cjs`: a 20 s CPU profile of the live server over the ssh console (SIGUSR1 opens the
  inspector on localhost, the script samples, prints self and inclusive time by function and file, and closes it).
  deploy/README.md "Slow or 503" says when to use it and how to read steal time.

## Suggestions

1. **Alert on the loop.** A monitor rule on `load.lagMs`: yellow above 500 ms, red above 2 s, like `desk-bill`; and a
   second one on steal (read `/proc/stat` on Linux) so a throttled or oversubscribed host shows in the HUD before it
   503s. Both are one `monitor.ts` rule each; the figures already exist.
2. **Keep the event loop free of batch work.** Run the backup's copy, integrity check, gzip, encrypt and verify, and
   the export's parse and `git`, in a `worker_threads` worker (better-sqlite3 opens the file again there) or a child
   process. Until then, stream the gzip (`createGzip`) and drop the second synchronous integrity check of the
   downloaded copy, or run it only nightly.
3. **Aggregates in SQL, by rule.** `Table` has `count` and `sum`; add `exists` and use them wherever the result is a
   number or a boolean. A lint or a core test that fails on `.where(...).reduce(` / `.where(...).length` would have
   caught `debited`. The same applies to `walkIdleHome` (newest-first with a LIMIT), `reconcileDue` and
   `stopOverdueForks` (remember "done for day X" in `meta` instead of scanning `system` events every 5 s), and the
   `/api/kpis` route (eight full `events` joins per request). The server still reads 15 MB/s after the fix: cheap
   now, not free.
   *Done (item 3 PR):* `Table.exists`; core test `aggregates-in-sql.test.ts` fails on a row load reduced to a number
   or a boolean (allowlist with reasons); `walkIdleHome` reads newest-first and stops at the 2-minute edge;
   `reconcileDue` and `stopOverdueForks` read `meta` markers; `/api/kpis` runs its Join scan once per request.
4. **An index on `events(ts)`** (or `(type, ts)`): every "since" query on events walks an index that has no time in
   it and loads rows to test `ts`. One migration.
5. **Make the health check honest.** Serve `/api/health` without touching the database, raise the check timeout to
   10-15 s, and keep the richer figures on a separate route the monitor reads. A slow server should stay reachable;
   only a dead one should be pulled. Consider a 60 s grace after a redeploy's restart (the entrypoint could touch a
   file the check reads).
6. **Fewer, cheaper boots.** Batch CI redeploys (at most one per 15 min, or only when `packages/{core,server,runtime}`
   changed) and prebuild the server in the image (`esbuild` to JS at deploy time) instead of `tsx` compiling on the
   volume at every start. Skip the backup catch-up when the last copy is under an hour old (it already is hourly).
7. **A tick budget with a breakdown.** Time each phase of `tickOnce` and log any tick over 500 ms with the phase that
   took it; one line per slow tick is enough to find the next `debited` without a profiler. A core test on a seeded
   database (100k events, 5k debits, 50 grants) asserting a tick under a fixed time would stop the regression at PR time.
8. **Hosted collectives.** Each hosted world runs its own 5 s tick in the same process; stagger them and cap how many
   the host runs, or the next town doubles everything above.
9. **Capacity is a setting, not a surprise.** `TOWN_MACHINE` now pins the dedicated core, and deploy/README.md says
   why. If the host ever goes back to a shared size, watch `fly_instance_cpu_balance` first (the Fly dashboard shows
   it; the Prometheus API refused the personal org slug on 10-31).
