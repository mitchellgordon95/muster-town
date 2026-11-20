/**
 * The exploration journal (gr_6id9g7u9cj step 2): one town-kept topic page "Exploration journal" per goal-directed
 * building, one line per exploration that closed (date, direction, outcome, adjusted tokens), newest first, the last
 * JOURNAL_MAX_LINES kept. The explore tick appends a line as each explorer's reservation closes, seeds a missing page
 * from the last JOURNAL_SEED_DAYS of explorations, and attaches the page to every new explorer's assignment so the fork
 * reads it in full before it picks a direction. The manager and its forks may still rewrite the page (revisions kept);
 * the town keeps any text above the first line.
 */
import type { BankReservation, Building, Doc } from "@muster-town/schema";
import { createDoc, updateDoc } from "./domain.ts";
import { assignmentSpent } from "./explore.ts";
import { laneGated } from "./lanes.ts";
import { lastWriterOf, topicPage } from "./memory.ts";
import { oneLine } from "./text.ts";
import { stamp } from "./time.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

export const JOURNAL_TITLE = "Exploration journal";
/** Lines kept on the page; older ones fall off the bottom (like LOG_MAX_LINES). */
export const JOURNAL_MAX_LINES = 60;
/** A new page is seeded from the explorations that closed in this many days. */
export const JOURNAL_SEED_DAYS = 7;

const JOURNAL_HEAD = `Kept by the town (gr_6id9g7u9cj): one line per exploration in this building, newest first: when it closed, the direction it took (its report's title), the outcome, and the adjusted tokens it spent. Explorers read this before they pick a direction and name the lines they built on.`;
/** A journal line: "- 2026-11-19 14:30 UTC | …". */
const LINE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \|/;

/** The first sentence of a report's Findings (else its first body line), for "nothing: <reason>". */
export function reportReason(body: string): string {
  const findings = /^##\s*Findings\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)?.[1] ?? body;
  const first = findings.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*/g, "").trim()).find((l) => l && !l.startsWith("#")) ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  return oneLine(sentence, 160);
}

/** The journal line for one closed reservation: its chain's latest report, its proposal (if any) and its chain's spend. */
export function journalLine(world: World, r: BankReservation): string {
  const a = r.assignmentId ? world.assignments.get(r.assignmentId) : undefined;
  const chain = a ? a.chainId ?? a.id : null;
  const ids = chain ? (world.db.prepare("SELECT id FROM assignments WHERE id = ? OR chainId = ?").all(chain, chain) as { id: string }[]).map((x) => x.id) : [];
  const marks = ids.map(() => "?").join(",");
  const report: Doc | undefined = ids.length ? world.docs.first(`type = 'report' AND assignmentId IN (${marks})`, ids, "ORDER BY createdAt DESC, rowid DESC") : undefined;
  const grantId = ids.length ? (world.db.prepare(`SELECT json_extract(payload, '$.grantId') AS g FROM events WHERE type = 'exploration.proposed' AND json_extract(payload, '$.assignmentId') IN (${marks}) ORDER BY id DESC LIMIT 1`).get(...ids) as { g: string | null } | undefined)?.g ?? null : null;
  const spent = ids.length ? ids.reduce((s, id) => s + assignmentSpent(world, id), 0) : r.spentTokens ?? 0;
  const direction = report ? `"${oneLine(report.title, 140)}" (${report.id})` : "no report";
  const g = grantId ? world.grants.get(grantId) : undefined;
  const outcome = grantId ? `proposed ${grantId}${g?.title ? ` "${oneLine(g.title, 60)}"` : ""}` : `nothing: ${report ? reportReason(report.body) || "no reason given" : "the session ended without a report"}`;
  return `- ${stamp(r.closedAt ?? r.openedAt)} | ${direction} | ${outcome} | ${spent.toLocaleString("en-US")} tokens`;
}

/** Split a page body into the text above its lines (kept as written) and its journal lines. */
function splitPage(body: string): { head: string; lines: string[] } {
  const all = body.split("\n");
  const at = all.findIndex((l) => LINE.test(l));
  if (at < 0) return { head: body.trim() || JOURNAL_HEAD, lines: [] };
  return { head: all.slice(0, at).join("\n").trim() || JOURNAL_HEAD, lines: all.slice(at).filter((l) => LINE.test(l)) };
}

/** Write the journal's body: the head, then the lines newest first, at most JOURNAL_MAX_LINES. A rewrite keeps a revision. */
function writeJournal(world: World, b: Building, cur: Doc | undefined, head: string, lines: string[]): Doc | null {
  const body = `${head}\n\n${lines.slice(0, JOURNAL_MAX_LINES).join("\n") || "(no explorations yet)"}`;
  const authorId = b.managerAgentId;
  if (!authorId) return cur ?? null;
  if (!cur) return createDoc(world, { type: "wiki", state: "building", title: JOURNAL_TITLE, body, authorId, authorKind: "agent", buildingId: b.id, topicOf: b.id, tags: ["town-kept"] }, `The town started the topic page "${JOURNAL_TITLE}" for ${b.name}`);
  if (cur.body === body) return cur;
  world.db.prepare("INSERT INTO doc_revisions (docId, title, body, authorId, replacedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(cur.id, cur.title, cur.body, lastWriterOf(world, cur), authorId, nowIso());
  return updateDoc(world, cur.id, { body, state: "building" });
}

/** Mark a reservation's line as written, so the tick writes it once. */
function markJournaled(world: World, r: BankReservation, docId: string): void {
  world.events.append({ type: "exploration.journaled", buildingId: r.buildingId, text: `The town added reservation ${r.id}'s line to the "${JOURNAL_TITLE}"`, payload: { reservationId: r.id, assignmentId: r.assignmentId, docId } });
}

const since = (now: Date) => new Date(now.getTime() - JOURNAL_SEED_DAYS * 24 * 60 * 60_000).toISOString();

/** The building's journal page, seeded from the last JOURNAL_SEED_DAYS of closed explorations when missing. Null: no manager to author it, or the Town Hall. */
export function ensureJournal(world: World, b: Building, now = new Date()): Doc | null {
  if (!laneGated(b)) return null;
  const cur = topicPage(world, b.id, JOURNAL_TITLE);
  if (cur) return cur;
  // a reservation whose chain still runs is left to the tick, which adds its line once its tokens are booked
  const closed = world.bankReservations.where("buildingId = ? AND closedAt IS NOT NULL AND closedAt >= ?", [b.id, since(now)], "ORDER BY closedAt DESC").filter((r) => !chainRunning(world, r));
  const doc = writeJournal(world, b, undefined, JOURNAL_HEAD, closed.map((r) => journalLine(world, r)));
  if (doc) for (const r of closed) if (!journaled(world, r.id)) markJournaled(world, r, doc.id);
  return doc;
}

function journaled(world: World, reservationId: string): boolean {
  return !!world.db.prepare("SELECT 1 FROM events WHERE type = 'exploration.journaled' AND json_extract(payload, '$.reservationId') = ? LIMIT 1").get(reservationId);
}

/** Whether a session of the reservation's chain is still running: its tokens are booked only when it ends (endSession). */
function chainRunning(world: World, r: BankReservation): boolean {
  if (!r.assignmentId) return false;
  return !!world.db.prepare(`SELECT 1 FROM sessions s JOIN assignments a ON a.id = s.assignmentId
    WHERE s.status = 'running' AND COALESCE(a.chainId, a.id) = (SELECT COALESCE(chainId, id) FROM assignments WHERE id = ?) LIMIT 1`).get(r.assignmentId);
}

/**
 * The tick's journal step: every goal-directed building with a manager has its page, and each reservation closed in
 * the last JOURNAL_SEED_DAYS gets its line on top once none of its chain's sessions runs (so its tokens are booked:
 * at close a desk session often has not ended yet). Cheap once the pages exist.
 */
export function ensureJournals(world: World, now = new Date()): Doc[] {
  for (const b of world.buildings.all()) if (b.managerAgentId && laneGated(b) && !topicPage(world, b.id, JOURNAL_TITLE)) ensureJournal(world, b, now);
  const due = world.bankReservations.where(`closedAt IS NOT NULL AND closedAt >= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'exploration.journaled'
    AND json_extract(e.payload, '$.reservationId') = bank_reservations.id)`, [since(now)], "ORDER BY closedAt ASC");
  const written: Doc[] = [];
  for (const r of due) {
    if (chainRunning(world, r)) continue;
    const b = world.buildings.get(r.buildingId);
    const cur = b && laneGated(b) ? topicPage(world, b.id, JOURNAL_TITLE) : undefined;
    if (!b || !cur) continue;
    const { head, lines } = splitPage(cur.body);
    const doc = writeJournal(world, b, cur, head, [journalLine(world, r), ...lines]);
    if (doc) { markJournaled(world, r, doc.id); written.push(doc); }
  }
  return written;
}
