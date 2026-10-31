/** Readable text for verb results. Unknown shapes fall back to an indented key: value dump. */
type R = Record<string, any>;

const isObj = (v: unknown): v is R => !!v && typeof v === "object" && !Array.isArray(v);
const when = (iso?: string | null) => (iso ? iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z") : "");
const one = (s: unknown, n = 100) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Generic fallback: YAML-ish, multi-line strings indented. */
function dump(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return `${indent}(nothing)`;
  if (typeof v !== "object") return indent + String(v);
  const lines: string[] = [];
  const entries: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [`- [${i}]`, x]) : Object.entries(v);
  if (!entries.length) return `${indent}${Array.isArray(v) ? "(none)" : "{}"}`;
  for (const [k, x] of entries) {
    if (x === undefined) continue;
    if (x !== null && typeof x === "object") {
      lines.push(`${indent}${k}:`);
      lines.push(dump(x, indent + "  "));
    } else if (typeof x === "string" && x.includes("\n")) {
      lines.push(`${indent}${k}: |`);
      for (const l of x.split("\n")) lines.push(`${indent}  ${l}`);
    } else lines.push(`${indent}${k}: ${x === null ? "-" : x}`);
  }
  return lines.join("\n");
}

function docRow(d: R): string {
  const meta = [d.type, d.state, d.author ? `by ${d.author}` : "", when(d.updatedAt ?? d.createdAt)].filter(Boolean).join(" · ");
  return `${d.id}  ${d.title}\n    ${meta}${d.excerpt ? `\n    ${one(d.excerpt, 160)}` : ""}`;
}

function look(r: R): string {
  const me = r.me ?? {};
  const out: string[] = [];
  const where = r.building ? `${r.building.name} [${r.building.id}]` : "outside";
  out.push(`${me.name} (${me.id}) · ${me.status} · ${where}${me.place ? ` at ${me.place}` : ""}`);
  if (r.building?.goal) out.push(`Goal: ${one(r.building.goal, 200)}`);
  const n = r.notices ?? {};
  const notes = [`${n.unread ?? 0} unread`, `${n.mentions ?? 0} mentions`, `${n.pendingAssignments ?? 0} pending assignments`];
  out.push(`\nNotices: ${notes.join(", ")}`);
  if (n.currentAssignment) out.push(`Current assignment: ${n.currentAssignment}`);
  if (n.nextMeeting) out.push(`Next meeting: ${n.nextMeeting.title} (${n.nextMeeting.id}) ${n.nextMeeting.phase} at ${when(n.nextMeeting.at)}`);
  const nearby: R[] = r.nearby ?? [];
  out.push(`\nNearby${nearby.length ? "" : ": nobody"}`);
  for (const a of nearby) out.push(`  ${String(a.name).padEnd(14)} ${a.id.padEnd(14)} ${String(a.kind ?? "").padEnd(6)} ${String(a.status ?? "").padEnd(9)} ${one(a.activity, 60)}`);
  if (isObj(n.digest)) out.push(`\nWhile you were away\n${formatDigest(n.digest)}`);
  const places: R[] = r.places ?? [];
  if (places.length) out.push(`\nPlaces: ${places.map((p) => p.id).join(", ")}`);
  return out.join("\n");
}

function messages(r: R): string {
  const ms: R[] = [...(r.messages ?? [])].sort((a, b) => String(b.at ?? b.createdAt ?? "").localeCompare(String(a.at ?? a.createdAt ?? "")));
  if (!ms.length) return r.note ?? "No unread messages.";
  return ms.map((m) => {
    const refs = [m.docId ? `doc ${m.docId}` : "", m.meetingId ? `meeting ${m.meetingId}` : ""].filter(Boolean).join(", ");
    return `[${when(m.at ?? m.createdAt)}] ${m.kind} from ${m.from ?? m.fromId}${m.fromId && m.from !== m.fromId ? ` (${m.fromId})` : ""}${refs ? ` · ${refs}` : ""}\n  ${String(m.body ?? "").split("\n").join("\n  ")}`;
  }).join("\n\n");
}

function docs(list: R[], empty: string): string {
  return list.length ? list.map(docRow).join("\n") : empty;
}

function readDoc(d: R): string {
  const meta = [d.type, d.state, d.author ? `by ${d.author}` : "", d.buildingId ? `in ${d.buildingId}` : "", d.verdict ? `verdict ${d.verdict}` : "", d.decision ? `decision ${d.decision}` : "", `updated ${when(d.updatedAt)}`].filter(Boolean).join(" · ");
  const out = [`# ${d.title}`, `${d.id} · ${meta}`];
  if (d.tags?.length) out.push(`tags: ${d.tags.join(", ")}`);
  out.push("", String(d.body ?? ""));
  const urls: string[] = d.provenance?.urls ?? [];
  const sources: R[] = Array.isArray(d.sources) ? d.sources : [];
  if (sources.length || urls.length) {
    out.push("", "Sources:");
    sources.forEach((s) => out.push(`  ${s.id ?? ""} ${s.title ?? ""}`.trimEnd()));
    urls.forEach((u) => out.push(`  ${u}`));
  }
  return out.join("\n");
}

function assignments(r: R): string {
  const list: R[] = r.assignments ?? [];
  if (!list.length) return "No assignments.";
  return list.map((a) => `${a.id === r.current ? "*" : " "} ${a.id}  [${a.status}] ${a.title}${a.createdBy ? ` (from ${a.createdBy})` : ""}\n    ${one(a.description, 160)}`).join("\n");
}

const formatters: Record<string, (r: R) => string> = {
  look,
  inbox: messages,
  board: (r) => `${r.building ? `${r.building.name} board\n` : ""}${docs(r.docs ?? [], "The board is empty.")}`,
  search: (r) => docs(r.results ?? [], "No results."),
  read: readDoc,
  assignments,
  tell: (r) => `Sent to ${r.to}${r.messageId ? ` (${r.messageId})` : ""}.`,
  say: (r) => (r.heardBy?.length ? `Heard by ${r.heardBy.join(", ")}.` : "Nobody was close enough to hear."),
  go: (r) => `Arrived at ${r.place ?? r.to}${r.pos ? ` (${r.pos.x},${r.pos.y})` : ""}.`,
  write: (r) => `Saved ${r.id} (${r.state}).`,
};

export function formatResult(verb: string, result: unknown): string {
  const f = formatters[verb];
  if (f && isObj(result)) {
    try { return f(result); } catch { /* fall through to the generic dump */ }
  }
  return dump(result);
}

export function formatDigest(d: R | null): string {
  if (!d) return "No digest: you haven't been away (or the server has nothing to catch you up on).";
  const out = [`Since ${when(d.offlineSince) || "your last session"}:`];
  /** counts (the v1.4 MailboxDigest) or lists (if the server ever sends items) */
  const section = (title: string, v: unknown, hint: string, render: (x: R) => string) => {
    if (typeof v === "number") { out.push(`  ${title}: ${v}${v ? `  (${hint})` : ""}`); return; }
    const list = Array.isArray(v) ? (v as R[]) : [];
    out.push(`  ${title}: ${list.length}${list.length ? `  (${hint})` : ""}`);
    list.forEach((x) => out.push("    " + render(x)));
  };
  const msg = (m: R) => `[${when(m.at ?? m.createdAt)}] ${m.kind ? `${m.kind} ` : ""}from ${m.from ?? m.fromId ?? "?"}${m.docId ? ` · doc ${m.docId}` : ""}: ${one(m.body ?? m.text, 140)}`;
  section("Messages", d.messages, "muster-town inbox", msg);
  section("Mentions", d.mentions, "muster-town inbox", msg);
  section("Assignments offered", d.assignmentsOffered, "muster-town assignments", (a) => `${a.id}  ${a.title ?? ""}${a.status ? ` [${a.status}]` : ""}`);
  const missed: R[] = Array.isArray(d.meetingsMissed) ? d.meetingsMissed : [];
  out.push(`  Meetings missed: ${missed.length}`);
  missed.forEach((m) => out.push(`    ${m.id}  ${m.title ?? ""}${m.notesDocId ? ` · notes: muster-town read --id ${m.notesDocId}` : " · no notes"}`));
  return out.join("\n");
}
