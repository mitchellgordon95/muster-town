// Load 1 of the stress test (grant gr_wqnunw5yd8): N WebSocket viewers against the THROWAWAY (never muster.town), ramped
// 10 → 25 → 50 → 100 → 200 → 400 while K scripted bodies walk and talk so every client has fanout to receive.
//   node scripts/stress/viewers.mjs --url https://muster-town-stress.fly.dev [--steps 10,25,50,100,200,400] [--hold 60]
//        [--walkers 8] [--admin-token at_... | STRESS_ADMIN_TOKEN | ~/.muster-stress/admin-token] [--stagger 20] [--procs 1]
// The sockets live in --procs forked worker processes (split evenly) so one Node event loop on the desk is not the ceiling
// before the server is; each worker reports its own event-loop p99 ("client loop" column): when that is high the event-lag
// column is the desk's lag, not the server's, so split further.
// Per client: time to first snapshot, bytes and frames, event lag (receive time − the event's server `ts`), "too slow" closes (1013),
// errors. Per step: health latency and `load` (lagMs, rssMb, wsClients) polled every 2 s. The ramp stops at the first failure signal
// (health slower than 2 s or failing, RSS over 1.6 GB, any dropped client); the max is the last step that passed.
// Results: ~/.muster-stress/results/<stamp>-viewers.md (one row per step) and .jsonl (the raw numbers).
import WebSocket from "ws";
import { fork } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { adminToken, failureSignal, fmt, healthPoller, parseArgs, percentile, pick, probeHealth, refuseLive, resultFiles, sleep, summarizeHealth, townFacts, verb, visitors } from "./lib.mjs";

const LOOP_RES_MS = 20;

// --- worker: holds its share of the sockets; the parent drives it over IPC ({id, op: open|reset|report|close})
if (process.env.STRESS_WORKER) {
  const wsBase = process.env.STRESS_WS_BASE;
  const staggerMs = Number(process.env.STRESS_STAGGER ?? 20);
  const loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
  loop.enable();
  const clients = [];
  function openClient(i, step) {
    const c = { i, step, opened: performance.now(), snapshotMs: null, frames: 0, bytes: 0, posFrames: 0, events: 0, lags: [], closeCode: null, closeReason: "", errors: 0 };
    const sock = new WebSocket(`${wsBase}/ws`, { perMessageDeflate: false });
    sock.on("message", (data) => {
      c.frames++; c.bytes += data.length;
      // cheap type sniff first; parse only what needs a field
      const s = String(data);
      if (c.snapshotMs === null && s.startsWith('{"type":"snapshot"')) { c.snapshotMs = performance.now() - c.opened; return; }
      if (s.startsWith('{"type":"agents.pos"')) { c.posFrames++; return; }
      if (s.startsWith('{"type":"event"')) {
        c.events++;
        const m = /"ts":"([^"]+)"/.exec(s);
        if (m) c.lags.push(Date.now() - Date.parse(m[1]));
      }
    });
    sock.on("close", (code, reason) => { c.closeCode = code; c.closeReason = String(reason); });
    sock.on("error", () => { c.errors++; });
    c.sock = sock;
    clients.push(c);
  }
  process.on("message", async (m) => {
    let reply = {};
    if (m.op === "open") { for (let i = clients.length; i < m.n; i++) { openClient(i, m.step); await sleep(staggerMs); } reply = { open: clients.length }; }
    else if (m.op === "reset") { for (const c of clients) { c.lags = []; c.frames = 0; c.bytes = 0; c.posFrames = 0; c.events = 0; } loop.reset(); }
    else if (m.op === "report") reply = { clients: clients.map(({ sock, ...rest }) => rest), loopP99Ms: Math.max(0, loop.percentile(99) / 1e6 - LOOP_RES_MS), loopMaxMs: Math.max(0, loop.max / 1e6 - LOOP_RES_MS) };
    else if (m.op === "close") { for (const c of clients) c.sock.close(); setTimeout(() => process.exit(0), 500); }
    process.send({ id: m.id, ...reply });
  });
} else {

const args = parseArgs(process.argv.slice(2));
if (!args.url) { console.error("usage: viewers.mjs --url <throwaway url> [--steps 10,25,50,100,200,400] [--hold 60] [--walkers 8] [--procs 1]"); process.exit(2); }
const base = refuseLive(args.url);
const wsBase = base.replace(/^http/, "ws");
const steps = String(args.steps ?? "10,25,50,100,200,400").split(",").map(Number);
const holdMs = Number(args.hold ?? 60) * 1000;
const walkersN = Number(args.walkers ?? 8);
const staggerMs = Number(args.stagger ?? 20);
const procsN = Math.max(1, Number(args.procs ?? 1));

const out = resultFiles("viewers");
const first = await probeHealth(base);
if (!first.ok) { console.error(`target not healthy: ${first.error ?? first.ms + " ms"}`); process.exit(1); }
const facts = await townFacts(base);
out.note(`# Viewer ramp against ${base} (${new Date().toISOString()})`);
out.note(`commit ${first.commit ?? "?"}; snapshot ${(facts.bytes / 1024).toFixed(1)} KB, ${facts.agents} agents, ${facts.buildings} buildings; steps ${steps.join("/")}, hold ${holdMs / 1000} s, walkers ${walkersN}, client processes ${procsN}`);
if (!first.load) out.note("WARNING: health has no `load` field (server older than the load commit): server-side lag and RSS will be missing");

// --- walkers: K visitors walking between places and saying a line now and then (the fanout every viewer receives)
let walking = true;
const walkerTasks = [];
let walkerErrors = 0;
if (walkersN > 0) {
  const token = adminToken(args);
  if (!token) { console.error("walkers need the throwaway's admin token (--admin-token, STRESS_ADMIN_TOKEN or ~/.muster-stress/admin-token); or pass --walkers 0"); process.exit(2); }
  const ws = await visitors(base, token, "stress-walker", walkersN);
  for (const w of ws) {
    walkerTasks.push((async () => {
      let n = 0;
      while (walking) {
        const r = await verb(base, w.token, "go", { to: pick(facts.places) });
        if (!r.ok) { walkerErrors++; await sleep(1000); }
        if (++n % 3 === 0 && walking) { const s = await verb(base, w.token, "say", { text: `stress walker ${w.name} step ${n}` }); if (!s.ok) walkerErrors++; }
      }
    })());
  }
  out.note(`${ws.length} walkers started`);
}

// --- viewers live in the workers
const workers = [];
let nextId = 1;
const pending = new Map();
for (let p = 0; p < procsN; p++) {
  const w = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, STRESS_WORKER: "1", STRESS_WS_BASE: wsBase, STRESS_STAGGER: String(staggerMs) }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  w.on("message", (m) => { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } });
  w.on("exit", (code) => { if (walking) out.note(`WARNING: client process ${p} exited (${code})`); });
  workers.push(w);
}
const call = (w, msg) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); w.send({ id, ...msg }); });
const share = (n, p) => Math.floor(n / procsN) + (p < n % procsN ? 1 : 0);

let stopReason = null;
let maxPassed = 0;
out.note("");
out.note("| viewers | ws (server) | snapshot p50/p95 ms | frames/s/client | kB/s/client | event lag p50/p95 ms | health p95 ms | lagMs p50/max | rss max MB | drops (1013) | errors | client loop p99 ms | result |");
out.note("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const n of steps) {
  await Promise.all(workers.map((w, p) => call(w, { op: "open", n: share(n, p), step: n })));
  await Promise.all(workers.map((w) => call(w, { op: "reset" })));
  const poller = healthPoller(base, 2000);
  const t0 = performance.now();
  await sleep(holdMs);
  const secs = (performance.now() - t0) / 1000;
  await poller.stop();
  const h = summarizeHealth(poller.samples);
  const reports = await Promise.all(workers.map((w) => call(w, { op: "report" })));
  const clients = reports.flatMap((r) => r.clients);
  const clientLoopP99 = Math.max(...reports.map((r) => r.loopP99Ms));
  const fresh = clients.filter((c) => c.step === n);
  const snaps = fresh.map((c) => c.snapshotMs).filter((v) => v !== null);
  const noSnapshot = fresh.filter((c) => c.snapshotMs === null).length;
  const lags = clients.flatMap((c) => c.lags);
  const drops = clients.filter((c) => c.closeCode === 1013).length;
  const otherClosed = clients.filter((c) => c.closeCode !== null && c.closeCode !== 1013).length;
  const errors = clients.reduce((a, c) => a + c.errors, 0) + noSnapshot;
  const open = clients.filter((c) => c.closeCode === null).length;
  const fps = clients.reduce((a, c) => a + c.frames, 0) / secs / n;
  const kbps = clients.reduce((a, c) => a + c.bytes, 0) / secs / n / 1024;
  const reasons = failureSignal(h, [
    ...(drops ? [`${drops} client(s) closed 1013 too slow`] : []),
    ...(otherClosed ? [`${otherClosed} client(s) closed by the server`] : []),
    ...(noSnapshot ? [`${noSnapshot} client(s) got no snapshot within the hold`] : []),
  ]);
  const deskWarning = clientLoopP99 > 100 ? ` (client loop p99 ${fmt(clientLoopP99)} ms: event lag is the desk's, raise --procs)` : "";
  const row = { step: n, open, server: h, snapshotP50: percentile(snaps, 50), snapshotP95: percentile(snaps, 95), framesPerSecPerClient: fps, kbPerSecPerClient: kbps, eventLagP50: percentile(lags, 50), eventLagP95: percentile(lags, 95), eventsSeen: lags.length, drops, otherClosed, errors, walkerErrors, clientLoopP99, clientLoopMax: Math.max(...reports.map((r) => r.loopMaxMs)), procs: procsN, reasons, secs };
  out.row(row);
  out.note(`| ${n} | ${fmt(h.wsClients)} | ${fmt(row.snapshotP50)}/${fmt(row.snapshotP95)} | ${fmt(fps, 1)} | ${fmt(kbps, 1)} | ${fmt(row.eventLagP50)}/${fmt(row.eventLagP95)} (${lags.length}) | ${fmt(h.healthP95)} | ${fmt(h.lagP50)}/${fmt(h.lagMax)} | ${fmt(h.rssMax)} | ${drops} | ${errors} | ${fmt(clientLoopP99)} | ${reasons.length ? "FAIL: " + reasons.join("; ") : "pass"}${deskWarning} |`);
  if (reasons.length) { stopReason = reasons.join("; "); break; }
  maxPassed = n;
}
out.note("");
out.note(stopReason ? `Ceiling (viewers): last step that passed = ${maxPassed}; stopped at the next step on: ${stopReason}` : `Ceiling (viewers): every step passed up to ${maxPassed}; no failure signal (raise --steps to find the ceiling)`);

walking = false;
await Promise.all(workers.map((w) => call(w, { op: "close" })));
await Promise.race([Promise.all(walkerTasks), sleep(35_000)]);
await sleep(500);
const after = await probeHealth(base);
out.note(`after the ramp: health ${fmt(after.ms)} ms, load ${JSON.stringify(after.load)}; walker errors ${walkerErrors}; results in ${out.md} and ${out.jsonl}`);
process.exit(0);
}
