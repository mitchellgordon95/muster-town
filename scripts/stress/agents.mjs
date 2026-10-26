// Load 2 of the stress test (grant gr_wqnunw5yd8): M scripted visitor agents against the THROWAWAY (never muster.town), ramped
// 5 → 10 → 20 → 40 → 80, each looping look / go / say / write / search / inbox over /mcp with a think time between verbs,
// like a desk session does. Optional --viewers V keeps V WebSocket viewers open so the fanout cost of the agents is in the numbers.
//   node scripts/stress/agents.mjs --url https://muster-town-stress.fly.dev [--steps 5,10,20,40,80] [--hold 60] [--think 2000]
//        [--viewers 5] [--admin-token at_... | STRESS_ADMIN_TOKEN | ~/.muster-stress/admin-token]
// Per step: p50/p95 per verb (go apart: it holds the request until the body arrives), verbs/s, errors, health latency and `load`.
// The ramp stops at the first failure signal (health slower than 2 s or failing, RSS over 1.6 GB, verb p95 over 2 s without `go`).
// Results: ~/.muster-stress/results/<stamp>-agents.md and .jsonl.
import WebSocket from "ws";
import { adminToken, failureSignal, fmt, healthPoller, parseArgs, percentile, pick, probeHealth, refuseLive, resultFiles, sleep, summarizeHealth, townFacts, verb, visitors } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.url) { console.error("usage: agents.mjs --url <throwaway url> [--steps 5,10,20,40,80] [--hold 60] [--think 2000] [--viewers 5]"); process.exit(2); }
const base = refuseLive(args.url);
const steps = String(args.steps ?? "5,10,20,40,80").split(",").map(Number);
const holdMs = Number(args.hold ?? 60) * 1000;
const thinkMs = Number(args.think ?? 2000);
const viewersN = Number(args.viewers ?? 5);
const token = adminToken(args);
if (!token) { console.error("needs the throwaway's admin token (--admin-token, STRESS_ADMIN_TOKEN or ~/.muster-stress/admin-token)"); process.exit(2); }

const out = resultFiles("agents");
const first = await probeHealth(base);
if (!first.ok) { console.error(`target not healthy: ${first.error ?? first.ms + " ms"}`); process.exit(1); }
const facts = await townFacts(base);
out.note(`# Agent ramp against ${base} (${new Date().toISOString()})`);
out.note(`commit ${first.commit ?? "?"}; snapshot ${(facts.bytes / 1024).toFixed(1)} KB, ${facts.agents} agents; steps ${steps.join("/")}, hold ${holdMs / 1000} s, think ${thinkMs} ms, viewers ${viewersN}`);

const viewers = [];
for (let i = 0; i < viewersN; i++) { const s = new WebSocket(`${base.replace(/^http/, "ws")}/ws`); s.on("error", () => {}); viewers.push(s); }

const VERBS = ["look", "go", "say", "write", "search", "inbox"];
const all = await visitors(base, token, "stress-agent", Math.max(...steps));
const samples = {}; // verb -> ms[] for the current step
const errors = {};  // verb -> count
let verbsDone = 0;
const reset = () => { for (const v of VERBS) { samples[v] = []; errors[v] = 0; } verbsDone = 0; };
reset();
let running = true;
const active = new Set();
function runAgent(a) {
  if (active.has(a.name)) return;
  active.add(a.name);
  (async () => {
    let n = 0;
    while (running) {
      const name = VERBS[n++ % VERBS.length];
      const input = name === "go" ? { to: pick(facts.places) }
        : name === "say" ? { text: `stress ${a.name} says ${n}` }
        : name === "write" ? { title: `stress note ${a.name} ${n}`, body: `Scripted note ${n} from ${a.name}. ` + "lorem ipsum ".repeat(40), type: "note" }
        : name === "search" ? { query: pick(["stress", "note", "lorem", "plaza", "town"]), limit: 10 }
        : {};
      const r = await verb(base, a.token, name, input);
      samples[name].push(r.ms); verbsDone++;
      if (!r.ok) errors[name]++;
      await sleep(thinkMs + Math.random() * thinkMs * 0.5);
    }
  })();
}

let stopReason = null;
let maxPassed = 0;
out.note("");
out.note("| agents | verbs/s | look p50/p95 | say p50/p95 | write p50/p95 | search p50/p95 | inbox p50/p95 | go p50/p95 | verb p95 (no go) | errors | health p95 ms | lagMs p50/max | rss max MB | ws | result |");
out.note("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const m of steps) {
  for (const a of all.slice(0, m)) runAgent(a);
  await sleep(Math.min(10_000, thinkMs * 2)); // let the new agents get going before the window
  reset();
  const poller = healthPoller(base, 2000);
  const t0 = performance.now();
  await sleep(holdMs);
  const secs = (performance.now() - t0) / 1000;
  await poller.stop();
  const h = summarizeHealth(poller.samples);
  const p = (v, q) => percentile(samples[v], q);
  const noGo = VERBS.filter((v) => v !== "go").flatMap((v) => samples[v]);
  const p95NoGo = percentile(noGo, 95);
  const errs = Object.values(errors).reduce((x, y) => x + y, 0);
  const reasons = failureSignal(h, [...((p95NoGo ?? 0) > 2000 ? [`verb p95 ${fmt(p95NoGo)} ms > 2000`] : []), ...(errs > 0 ? [`${errs} verb error(s)`] : [])]);
  const row = { step: m, verbsPerSec: verbsDone / secs, perVerb: Object.fromEntries(VERBS.map((v) => [v, { n: samples[v].length, p50: p(v, 50), p95: p(v, 95), errors: errors[v] }])), p95NoGo, errors: errs, server: h, reasons, secs };
  out.row(row);
  const pp = (v) => `${fmt(p(v, 50))}/${fmt(p(v, 95))}`;
  out.note(`| ${m} | ${fmt(verbsDone / secs, 2)} | ${pp("look")} | ${pp("say")} | ${pp("write")} | ${pp("search")} | ${pp("inbox")} | ${pp("go")} | ${fmt(p95NoGo)} | ${errs} | ${fmt(h.healthP95)} | ${fmt(h.lagP50)}/${fmt(h.lagMax)} | ${fmt(h.rssMax)} | ${fmt(h.wsClients)} | ${reasons.length ? "FAIL: " + reasons.join("; ") : "pass"} |`);
  if (reasons.length) { stopReason = reasons.join("; "); break; }
  maxPassed = m;
}
out.note("");
out.note(stopReason ? `Ceiling (scripted agents): last step that passed = ${maxPassed}; stopped at the next step on: ${stopReason}` : `Ceiling (scripted agents): every step passed up to ${maxPassed}; no failure signal (raise --steps to find the ceiling)`);
running = false;
for (const s of viewers) s.close();
await sleep(Math.min(35_000, thinkMs * 2 + 31_000)); // let in-flight `go` calls land
const after = await probeHealth(base);
out.note(`after the ramp: health ${fmt(after.ms)} ms, load ${JSON.stringify(after.load)}; results in ${out.md} and ${out.jsonl}`);
process.exit(0);
