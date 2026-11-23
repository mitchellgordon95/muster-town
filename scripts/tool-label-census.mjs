#!/usr/bin/env node
/**
 * Tool-label census (grant gr_93s00hyq1l, kr_dt3wys7zab and kr_qktzvx4n41): of a live town's latest `agent.tool`
 * lines, how many are a generic label that names nothing ("Reading files", "Searching files", …), and how many leak
 * a full path, an env var's value or a `$VAR`. The generic list and the leak test are the ones in
 * packages/runtime/src/describe.ts (GENERIC_LINES, LEAK), so the census and the unit test agree.
 *
 *   node scripts/tool-label-census.mjs [https://muster.town] [--limit=1000] [--relabel] [--examples=5]
 *
 * --relabel also labels the same Bash inputs with this checkout's describeTool, to compare live words with the next
 * deploy's. Inputs are stored clipped (500 chars of JSON), so a long command is cut: its first line is what counts.
 * Exit code 0 always: it measures, it doesn't gate.
 */
import { GENERIC_LINES, LEAK, describeTool } from "../packages/runtime/src/describe.ts";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a === undefined ? dflt : a.includes("=") ? a.split("=")[1] : true; };
const base = (args.find((a) => !a.startsWith("--")) ?? "https://muster.town").replace(/\/+$/, "");
const limit = Math.min(1000, Number(flag("limit", 1000)));
const examples = Number(flag("examples", 5));

/** A clipped JSON input, read as far as it goes (`{"command":"grep -n … ` with no closing quote). */
function inputOf(raw) {
  try { return JSON.parse(raw); } catch { /* clipped */ }
  const m = /^\{"command":"((?:[^"\\]|\\.)*)/.exec(raw ?? "");
  if (!m) return {};
  const s = m[1].replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, "");
  try { return { command: JSON.parse(`"${s}"`) }; } catch { return { command: s }; }
}

const res = await fetch(`${base}/api/events?limit=${limit}`);
if (!res.ok) { console.error(`GET /api/events: ${res.status}`); process.exit(0); }
const tools = (await res.json()).events.filter((e) => e.type === "agent.tool");
if (!tools.length) { console.log("no agent.tool lines in the window"); process.exit(0); }

function measure(label, lines) {
  const generic = lines.filter((l) => GENERIC_LINES.has(l.text));
  const leaks = lines.filter((l) => LEAK.test(l.text));
  const pct = (n) => `${((n / lines.length) * 100).toFixed(1)}%`;
  console.log(`\n${label}: ${lines.length} tool lines, ${generic.length} generic (${pct(generic.length)}), ${leaks.length} leaks`);
  const top = new Map();
  for (const l of generic) top.set(l.text, (top.get(l.text) ?? 0) + 1);
  for (const [t, n] of [...top].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(4)}  ${t}`);
  for (const l of leaks.slice(0, examples)) console.log(`  leak: ${l.text}`);
  return { generic: generic.length, leaks: leaks.length };
}

const first = tools[0].ts, last = tools[tools.length - 1].ts;
console.log(`${base}: ${tools.length} agent.tool lines, ${first} to ${last}`);
measure("live labels", tools.map((e) => ({ text: e.text })));
if (flag("relabel", false)) {
  const world = { layout: { place: () => null }, agents: new Map(), docs: new Map(), nameOf: (id) => id };
  measure("this checkout's labels", tools.map((e) => ({ text: describeTool(world, e.payload?.tool ?? "", inputOf(e.payload?.input)) })));
}
