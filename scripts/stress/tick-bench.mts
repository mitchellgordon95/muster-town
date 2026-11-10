// Runtime tick ms at k x the live world size (gr_n0p3ast5pp step 1, dc_er6dxw6kil; gr_db6ofyd0yf). Desk only; never touches muster.town.
// Run from the repo root: rm -f /tmp/bench1.db*; DB=/tmp/bench1.db node_modules/.bin/tsx scripts/stress/tick-bench.mts <k> [ticks=30] 2>/dev/null | grep '^{'
// Prints one JSON line: tick p50/p95/max and each phase's p50/p95/max over the measured ticks (after 5 warm-up ticks).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "@muster-town/core";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { HostBackend, startRuntime } from "@muster-town/runtime";

const ROOT = process.env.REPO ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const k = Number(process.argv[2] ?? 1), TICKS = Number(process.argv[3] ?? 30), WARM = 5;
// 1x = live muster.town read 2026-11-02T03:06Z (see note): 8 buildings, ~43 open assignments, ~100k events,
// ~2,000 docs (export payload files), sessions/assignment history assumed 3,000 / 2,500, 5k bank debits, 7 schedules.
const L = { buildings: 8, openPerBuilding: 5, events: 100_000, docs: 2_000, sessions: 3_000, doneAssignments: 2_500, debits: 5_000, grants: 6, meetings: 100, schedules: 7 };

const world = World.open(process.env.DB ?? ":memory:");
const seed = world.seedDefaults({ importDir: join(ROOT, "buildings/carbon-cycle"), townJsonPath: join(ROOT, "town.json") });
world.bank.addInput(seed.admin.id, { label: "bench", source: "subscription", model: "claude-sonnet-5-5", tokens: 1, recurrence: "daily", weeklyCapTokens: 1, nextCreditAt: "2099-01-01T00:00:00.000Z", token: "sk-ant-oat01-bench" });
const inp = world.bank.subscriptionInput()!;
world.db.prepare("INSERT INTO bank_credits (id, inputId, output, tokens, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)").run("bc_bench", inp.id, 1e9, 1e9, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
world.town.set({ operatingReserveTokens: 0 });
world.goals.patch(ROOT_GOAL_ID, { explore: process.env.EXPLORE !== "0" });
const clock = { t: Date.now() };
const admin = world.ops.ensureAvatar(seed.admin.id);

const t0 = performance.now();
// Bank: live has 17 inputs, 2 of them earmarks (GET /api/bank, /api/bank/streams)
for (let i = 0; i < 15 * k; i++) world.bank.addInput(seed.admin.id, { label: `in${i}`, source: "api-key", model: "m", tokens: 1000, apiKey: `sk-b-${i}` } as never);
for (let i = 0; i < 2 * k; i++) world.bank.addInput(seed.admin.id, { label: `ear${i}`, source: "api-key", model: "m", tokens: 3000, apiKey: `sk-e-${i}`, goalId: ROOT_GOAL_ID } as never);
const nB = L.buildings * k - world.buildings.all().length;
for (let i = 0; i < nB; i++) world.ops.createBuilding(null, { name: `Bench ${i}`, headcount: 4 });
const buildings = world.buildings.all();
const residents = world.agents.all().filter((a: any) => a.kind === "resident");
// open work: queued assignments on residents (the tick forks / starts them; sessions hang = "running" like live desks)
let open = 0;
for (const r of residents) for (let j = 0; j < Math.ceil(L.openPerBuilding * buildings.length / residents.length); j++) { try { world.ops.createWork(null, r.id, { title: `bench ${r.name} ${j}` }); open++; } catch { /* lane rules */ } }
// funded grants
for (let i = 0; i < L.grants * k; i++) { try { const b = buildings[i % buildings.length]; const g = world.grantDesk.create(admin, b.id, { keyResults: [{ text: `k${i}`, howToCheck: "h" }], objective: `o${i}`, stopCondition: "s", askTokens: 100_000 }); world.grantDesk.propose(admin, g.id); world.grantDesk.decide(admin, g.id, { action: "fund" }); } catch (e) { if (i === 0) console.error("grant:", String(e).slice(0, 120)); } }
// meetings (done history + one open standup per building)
for (const b of buildings) { try { world.ops.createMeeting(null, { kind: "standup", buildingId: b.id }); } catch {} }
// history rows, raw: clone a template row with fresh ids
function clone(table: string, n: number, mutate: (row: any, i: number) => void) {
  const tpl = world.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as any;
  if (!tpl) { console.error(`no template row in ${table}`); return 0; }
  const cols = (world.db.prepare(`PRAGMA table_xinfo(${table})`).all() as any[]).filter((c) => c.hidden === 0).map((c) => c.name);
  const ins = world.db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  world.db.transaction(() => { for (let i = 0; i < n; i++) { const r = { ...tpl }; mutate(r, i); ins.run(...cols.map((c) => r[c])); } })();
  return n;
}
const ag = residents.map((r: any) => r.id), bl = buildings.map((b: any) => b.id);
const iso = (ms: number) => new Date(clock.t - ms).toISOString();
const credit = "bc_bench";
world.db.transaction(() => {
  const ev = world.db.prepare("INSERT INTO events (ts, type, agentId, buildingId, text, payload) VALUES (?, ?, ?, ?, ?, ?)");
  const types = ["agent.tool", "agent.thought", "agent.status", "system", "doc.created"];
  for (let i = 0; i < L.events * k; i++) ev.run(iso(i * 5_000 / k), types[i % 5], ag[i % ag.length], bl[i % bl.length], `bench event ${i}`, JSON.stringify({ i }));
  const debit = world.db.prepare("INSERT INTO bank_debits (id, buildingId, agentId, creditId, createdAt, poolId, input, output, cacheRead, grantId) VALUES (?, ?, ?, ?, ?, 'general', 10, 20, 70, NULL)");
  for (let i = 0; i < L.debits * k; i++) debit.run(`bd_b_${i}`, bl[i % bl.length], ag[i % ag.length], credit, iso(i * 60_000 / k));
})();
const docsN = Math.max(0, L.docs * k - (world.db.prepare("SELECT COUNT(*) n FROM docs").get() as any).n);
clone("docs", docsN, (r, i) => { r.id = `dc_b_${i}`; r.title = `bench doc ${i}`; if ("authorId" in r) r.authorId = ag[i % ag.length]; if ("buildingId" in r) r.buildingId = bl[i % bl.length]; });
clone("assignments", L.doneAssignments * k, (r, i) => { r.id = `as_b_${i}`; r.status = "done"; r.agentId = ag[i % ag.length]; if ("buildingId" in r) r.buildingId = bl[i % bl.length]; for (const c of ["createdAt", "updatedAt", "startedAt", "endedAt", "completedAt"]) if (c in r) r[c] = iso(i * 300_000 / k); });
const asIds = (world.db.prepare("SELECT id FROM assignments WHERE id LIKE 'as_b_%'").all() as any[]).map((x) => x.id);
// a session template exists only once a session ran: make one via ops
try { const a0 = world.ops.createWork(null, ag[0], { title: "tpl" }); const se = world.ops.startSession(ag[0], { purpose: "work", model: "claude-opus-5-5", assignmentId: a0.id }); world.db.prepare("UPDATE sessions SET status='done', input=?, output=? WHERE id=?").run(60_000, 55_000, se.id); } catch (e) { console.error("tpl session:", String(e).slice(0, 120)); }
clone("sessions", L.sessions * k, (r, i) => { r.id = `se_b_${i}`; r.agentId = ag[i % ag.length]; if ("assignmentId" in r) r.assignmentId = asIds[i % asIds.length]; r.status = "done"; r.output = 20_000 + (i % 200) * 500; for (const c of ["startedAt", "endedAt", "createdAt"]) if (c in r) r[c] = iso(i * 250_000 / k); });
const count = (t: string, w = "") => (world.db.prepare(`SELECT COUNT(*) n FROM ${t} ${w}`).get() as any).n;
const sizes = { buildings: count("buildings"), agents: count("agents"), residents: residents.length, openAssignments: count("assignments", "WHERE status NOT IN ('done','cancelled')"), assignments: count("assignments"), docs: count("docs"), events: count("events"), sessions: count("sessions"), bankDebits: count("bank_debits"), bankInputs: count("bank_inputs"), grants: count("grants", "WHERE status = 'funded'"), meetings: count("meetings") };
console.error(`[bench k=${k}] built in ${Math.round(performance.now() - t0)} ms`, JSON.stringify(sizes));

// fake sdk: every session inits and then hangs (a running desk), so the world reaches a steady state
const sdk = { query() { const g = (async function* () { yield { type: "system", subtype: "init", session_id: "s", tools: [] }; await new Promise(() => {}); })(); return Object.assign(g, { async interrupt() {} }); } } as any;
const warn = console.warn; console.warn = () => {}; const log = console.log; console.log = () => {};
const runtime = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk, intervalMs: 0, exportDir: false, now: () => new Date(clock.t), deskBackend: new HostBackend() } as any);
const rows: any[] = [];
for (let i = 0; i < WARM + TICKS; i++) {
  clock.t += 5_000;
  const w0 = performance.now(); await runtime.tickOnce(); const wall = performance.now() - w0;
  if (i >= WARM) rows.push({ wall, ...runtime.tickStats().last! });
}
console.warn = warn; console.log = log;
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const out: any = { k, sizes, running: count("sessions", "WHERE status = 'running'"), tick: { p50: q(rows.map((r) => r.ms), .5), p95: q(rows.map((r) => r.ms), .95), max: Math.max(...rows.map((r) => r.ms)) }, wall: { p50: q(rows.map((r) => r.wall), .5), p95: q(rows.map((r) => r.wall), .95) }, phases: {} };
for (const ph of Object.keys(rows[0].phases)) { const xs = rows.map((r) => r.phases[ph] ?? 0); out.phases[ph] = { p50: q(xs, .5), p95: q(xs, .95), max: Math.max(...xs) }; }
out.sub = {};
for (const ph of Object.keys(rows[0].sub ?? {})) { const xs = rows.map((r) => r.sub?.[ph] ?? 0); out.sub[ph] = { p50: q(xs, .5), p95: q(xs, .95) }; }
console.log(JSON.stringify(out));
process.exit(0);
