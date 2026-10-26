// Shared bits of the stress harness (grant gr_wqnunw5yd8): target guard, health polling, visitors over the REST + MCP API,
// percentiles and result files. Node 22, no dependencies beyond the repo's `ws`.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const STRESS_DIR = process.env.STRESS_DIR ?? join(homedir(), ".muster-stress");

/** `--key value` and `--flag` into an object; numbers stay strings (callers coerce). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

/** The live town is never a target: the harness exits before a single request. */
export function refuseLive(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "muster.town" || host.endsWith(".muster.town")) {
    console.error(`refusing to run against ${host}: load tests run on the throwaway only (deploy/fly/throwaway.sh)`);
    process.exit(2);
  }
  return url.replace(/\/+$/, "");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const fmt = (v, d = 0) => (v === null || v === undefined ? "-" : typeof v === "number" ? v.toFixed(d) : String(v));

/** One health probe: latency and the `load` field (null when it failed or took over `timeoutMs`). */
export async function probeHealth(base, timeoutMs = 5000) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    return { ok: res.ok && body.ok === true, ms: performance.now() - t0, load: body.load ?? null, commit: body.commit ?? null };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, load: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Polls health every `everyMs` until stop() is called; `samples` collects every probe. */
export function healthPoller(base, everyMs = 2000) {
  const samples = [];
  let stopped = false;
  const loop = (async () => { while (!stopped) { samples.push({ at: Date.now(), ...(await probeHealth(base)) }); await sleep(everyMs); } })();
  return { samples, stop: async () => { stopped = true; await loop; } };
}

export function summarizeHealth(samples) {
  const ok = samples.filter((s) => s.ok);
  const ms = ok.map((s) => s.ms);
  const lag = ok.map((s) => s.load?.lagMs ?? 0);
  const rss = ok.map((s) => s.load?.rssMb ?? 0);
  return {
    probes: samples.length, failed: samples.length - ok.length,
    healthP50: percentile(ms, 50), healthP95: percentile(ms, 95), healthMax: ms.length ? Math.max(...ms) : null,
    lagP50: percentile(lag, 50), lagMax: lag.length ? Math.max(...lag) : null,
    rssMax: rss.length ? Math.max(...rss) : null,
    wsClients: ok.length ? ok[ok.length - 1].load?.wsClients ?? null : null,
  };
}

/** The ramp's abort rule from the grant plan: health slower than 2 s or failing, RSS over 1.6 GB (plus the load's own signal). */
export function failureSignal(h, extra = []) {
  const reasons = [];
  if (h.failed > 0) reasons.push(`${h.failed} health probe(s) failed`);
  if ((h.healthP95 ?? 0) > 2000) reasons.push(`health p95 ${fmt(h.healthP95)} ms > 2000`);
  if ((h.rssMax ?? 0) > 1600) reasons.push(`rss ${h.rssMax} MB > 1600`);
  return reasons.concat(extra);
}

export function adminToken(args) {
  const t = args["admin-token"] ?? process.env.STRESS_ADMIN_TOKEN ?? (existsSync(join(STRESS_DIR, "admin-token")) ? readFileSync(join(STRESS_DIR, "admin-token"), "utf8").trim() : "");
  return t || null;
}

/** Register (or reuse) `n` scripted visitors named `<prefix>-NN` on the target; tokens are cached per host in STRESS_DIR. */
export async function visitors(base, token, prefix, n) {
  const host = new URL(base).host.replace(/[^a-z0-9.-]/gi, "_");
  mkdirSync(STRESS_DIR, { recursive: true });
  const file = join(STRESS_DIR, `visitors-${host}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const out = [];
  for (let i = 1; i <= n; i++) {
    const name = `${prefix}-${String(i).padStart(2, "0")}`;
    if (!cache[name]) {
      const res = await fetch(`${base}/api/agents/visitors`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name, title: "stress harness" }) });
      if (!res.ok) throw new Error(`register ${name}: ${res.status} ${await res.text()}`);
      const body = await res.json();
      cache[name] = { id: body.agent.id, token: body.token };
      writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
    }
    out.push({ name, ...cache[name] });
  }
  return out;
}

/** One verb over `/mcp` (stateless JSON-RPC): returns {ms, ok, result|error}. `go` holds the request until arrival (≤ 30 s). */
export async function verb(base, token, name, args = {}, timeoutMs = 45_000) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = performance.now() - t0;
    if (!res.ok) return { ms, ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    const body = await res.json();
    const text = body.result?.content?.[0]?.text ?? "";
    if (body.error || body.result?.isError) return { ms, ok: false, error: body.error?.message ?? text.slice(0, 200) };
    return { ms, ok: true, result: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Place ids a body can walk to (from the snapshot), the agent count and the snapshot size in bytes. */
export async function townFacts(base) {
  const res = await fetch(`${base}/api/town`);
  const text = await res.text();
  const snap = JSON.parse(text);
  const places = snap.places.filter((p) => !/^desk:/.test(p.id)).map((p) => p.id);
  return { places, agents: snap.agents.length, buildings: snap.buildings.length, bytes: Buffer.byteLength(text) };
}

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Results go to STRESS_DIR/results/<stamp>-<kind>.{md,jsonl}; returns {md, jsonl, row(), note()}. */
export function resultFiles(kind) {
  const dir = join(STRESS_DIR, "results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const md = join(dir, `${stamp}-${kind}.md`);
  const jsonl = join(dir, `${stamp}-${kind}.jsonl`);
  return {
    md, jsonl,
    note: (line) => { appendFileSync(md, line + "\n"); console.log(line); },
    row: (obj) => appendFileSync(jsonl, JSON.stringify(obj) + "\n"),
  };
}
