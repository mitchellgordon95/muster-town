#!/usr/bin/env node
/**
 * Id census (grant gr_4upa0og9zc, kr_61a5puok88): of the ids cited in a live town's newest docs, how many open nothing
 * (dead) and how many read as a raw id instead of a name (raw label), by prefix. It mirrors the reader's rules in
 * packages/web/src/panels/Markdown.tsx (LINK_KINDS, OWNED_KINDS, MUTED_WHAT, idLabel), resolving each id against the
 * same API the web client asks:
 *
 * - link kinds (dc gr mt ag bl kr mf as se ak gl): a link; dead when the API has no such thing. Named when the client
 *   finds a name (a title, a key result's or goal's text, an agent's or building's name); `se_` and `mf_` always read
 *   as the id. A key result is named when the goal tree has it or a grant cited in the same doc does.
 * - owned kinds (sc gp): open their grant, building or goal when /api/scheduled or /api/goal-proposals has them, else
 *   a muted id.
 * - muted kinds (en ms us ob rs nt cr): a muted id whose tooltip says what it is. Not dead: it names what it is.
 * - any other prefix (jb_, ar_, gc_, …): plain text, dead.
 *
 *   node scripts/id-census.mjs [https://muster.town] [--limit=200] [--examples=3]
 *
 * An id right after a `/` is part of a URL (a picture, a hash link) and is not counted.
 * Shares are of id mentions (an id cited twice in one doc counts twice). Exit code 0 always: it measures, it doesn't gate.
 */
const args = process.argv.slice(2);
const flag = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a === undefined ? dflt : a.includes("=") ? a.split("=")[1] : true; };
const base = (args.find((a) => !a.startsWith("--")) ?? "https://muster.town").replace(/\/+$/, "");
const limit = Number(flag("limit", 200));
const examples = Number(flag("examples", 3));

const LINK_KINDS = ["dc", "gr", "mt", "ag", "bl", "kr", "mf", "as", "se", "ak"];
const OWNED_KINDS = ["sc", "gp"];
const MUTED_KINDS = ["en", "ms", "us", "ob", "rs", "nt", "cr"];
const GOAL_ID = "gl_(?:bl_[a-z0-9]{10}|[a-z0-9]{10}|town|join|trust|fund)";
/** Every id-shaped token: the ones the reader knows and any other two-letter prefix the town mints. */
const ANY_ID_RE = new RegExp(`\\b(?:${GOAL_ID}|[a-z]{2}_[a-z0-9]{10})\\b`, "g");

async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${base}${path}`);
      if (r.status === 404 || r.status === 400) return null;
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((f) => setTimeout(f, 500 * (i + 1)));
  }
  return undefined; // unknown: the API failed
}

const docsRes = await get(`/api/docs?limit=${limit}`);
if (!docsRes?.docs) { console.error("GET /api/docs failed"); process.exit(0); }
const docs = docsRes.docs;

// The reader's lookups, loaded once.
const tree = await get("/api/goals");
const goalTexts = new Map(), krTexts = new Map();
(function walk(n) { if (!n) return; goalTexts.set(n.id, n.text); for (const k of n.keyResults ?? []) krTexts.set(k.id, k.text); (n.children ?? []).forEach(walk); })(tree?.goal ?? tree?.root ?? tree);
const owned = new Map();
for (const s of (await get("/api/scheduled"))?.schedules ?? []) owned.set(s.id, s.grantId ?? s.buildingId);
const gps = await get("/api/goal-proposals");
for (const p of gps?.proposals ?? gps?.goalProposals ?? (Array.isArray(gps) ? gps : [])) { const at = p.resultId ?? p.targetId ?? p.parentId; if (at) owned.set(p.id, at); }

const PATH = { dc: "docs", gr: "grants", mt: "meetings", ag: "agents", bl: "buildings", as: "assignments", se: "sessions", ak: "asks" };
const cache = new Map();
/** Does the API return this id, and what keyResults does a grant carry. */
function lookup(id) {
  if (!cache.has(id)) {
    const k = id.slice(0, 2);
    const path = k === "mf" ? `/api/media/${id}` : k === "ak" ? `/api/asks/${id}?peek=1` : `/api/${PATH[k]}/${id}`;
    cache.set(id, k === "mf"
      ? fetch(`${base}${path}`, { method: "HEAD" }).then((r) => ({ ok: r.ok }), () => ({ ok: undefined }))
      : get(path).then((j) => ({ ok: j === undefined ? undefined : j !== null, json: j })));
  }
  return cache.get(id);
}

// Mentions, with the doc they sit in.
const mentions = [];
for (const d of docs) {
  const text = `${d.title ?? ""}\n${d.body ?? ""}`;
  // an id inside a URL or path (`/api/media/mf_….png`, `#/grant/gr_…`) is part of a link or picture, not a label
  for (const m of text.matchAll(ANY_ID_RE)) if (text[m.index - 1] !== "/") mentions.push({ id: m[0], doc: d.id });
}
const grantIds = [...new Set(mentions.filter((m) => m.id.startsWith("gr_")).map((m) => m.id))];
const fetchIds = [...new Set(mentions.map((m) => m.id).filter((id) => PATH[id.slice(0, 2)] || id.startsWith("mf_")))];
// a few at a time, to be gentle with the live town
for (let i = 0; i < fetchIds.length; i += 8) await Promise.all(fetchIds.slice(i, i + 8).map(lookup));
const grantKrs = new Map();
for (const g of grantIds) {
  const j = (await lookup(g)).json;
  const grant = j?.grant ?? j;
  grantKrs.set(g, new Set([...(grant?.keyResults ?? []), ...(grant?.archivedKeyResults ?? [])].map((k) => k.id)));
}
const docGrants = new Map();
for (const m of mentions) if (m.id.startsWith("gr_")) (docGrants.get(m.doc) ?? docGrants.set(m.doc, new Set()).get(m.doc)).add(m.id);

/** dead | raw | named | muted | unknown, for one mention. */
async function classify({ id, doc }) {
  const k = id.slice(0, 2);
  if (k === "gl") return goalTexts.has(id) ? "named" : "raw";
  if (k === "kr") {
    if (krTexts.has(id)) return "named";
    for (const g of docGrants.get(doc) ?? []) if (grantKrs.get(g)?.has(id)) return "named";
    return "raw"; // opens the goal tree, reads as the id
  }
  if (MUTED_KINDS.includes(k)) return "muted";
  if (OWNED_KINDS.includes(k)) return owned.has(id) ? "named" : "muted";
  if (!LINK_KINDS.includes(k)) return "dead";
  const r = await lookup(id);
  if (r.ok === undefined) return "unknown";
  if (!r.ok) return "dead";
  return k === "se" || k === "mf" ? "raw" : "named";
}

const rows = new Map();
const deadEx = new Map();
const tally = { dead: 0, raw: 0, named: 0, muted: 0, unknown: 0 };
for (const m of mentions) {
  const c = await classify(m);
  const p = m.id.startsWith("gl_") ? "gl" : m.id.slice(0, 2);
  const row = rows.get(p) ?? rows.set(p, { dead: 0, raw: 0, named: 0, muted: 0, unknown: 0, n: 0 }).get(p);
  row[c]++; row.n++; tally[c]++;
  if (c === "dead" || c === "raw") { const ex = deadEx.get(`${p}:${c}`) ?? deadEx.set(`${p}:${c}`, []).get(`${p}:${c}`); if (ex.length < examples && !ex.some((e) => e.id === m.id)) ex.push(m); }
}

const n = mentions.length;
const pct = (x, of = n) => of ? `${((x / of) * 100).toFixed(1)}%` : "-";
console.log(`${base}: ${n} id mentions in the ${docs.length} newest docs (${docs.at(-1)?.updatedAt ?? "?"} to ${docs[0]?.updatedAt ?? "?"})`);
console.log(`dead (opens nothing): ${tally.dead} = ${pct(tally.dead)}`);
console.log(`raw label (opens, reads as the id): ${tally.raw} = ${pct(tally.raw)}`);
console.log(`named: ${tally.named} = ${pct(tally.named)}; muted (says what it is, opens nothing by design): ${tally.muted} = ${pct(tally.muted)}${tally.unknown ? `; unknown (API failed): ${tally.unknown}` : ""}`);
console.log("\nprefix      n   dead    raw  named  muted");
for (const [p, r] of [...rows].sort((a, b) => b[1].n - a[1].n)) console.log(`${p.padEnd(4)} ${String(r.n).padStart(7)} ${String(r.dead).padStart(6)} ${String(r.raw).padStart(6)} ${String(r.named).padStart(6)} ${String(r.muted).padStart(6)}`);
if (examples > 0 && deadEx.size) {
  console.log("\nexamples:");
  for (const [key, ex] of deadEx) for (const e of ex) console.log(`  ${key.padEnd(9)} ${e.id} in ${e.doc}`);
}
