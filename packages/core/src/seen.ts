/**
 * What each human has seen, and the reader's delta (docs/legible-delegation.md §5 "Diff-first", build step 3). An ask's
 * card is written as a diff against what its reader has seen and said, never a briefing from scratch. The server knew
 * when a human decided and what they said in meetings; the `seen` table (migration 100) adds what they opened: a row
 * per human and target, written when a signed-in human opens a report, a grant or an ask over the API. Agents never
 * write rows. `readerDelta` puts the four together for one human and one target, and the manager's first message
 * carries it for each open grant of its building (prompts.ts `captainDeltaBlock`).
 */
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** What a human can have opened: a report (any doc), a grant, an ask. */
export type SeenKind = "report" | "grant" | "ask";

/** Record that a signed-in human opened a target now (the server's routes call it; never for an agent). */
export function markSeen(world: World, userId: string, kind: SeenKind, id: string): void {
  if (!userId) return;
  world.db.prepare("INSERT INTO seen (userId, targetKind, targetId, at) VALUES (?, ?, ?, ?) ON CONFLICT (userId, targetKind, targetId) DO UPDATE SET at = excluded.at")
    .run(userId, kind, id, nowIso());
}

function seenAt(world: World, userId: string, kind: SeenKind, ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = world.db.prepare(`SELECT targetId, at FROM seen WHERE userId = ? AND targetKind = ? AND targetId IN (${ids.map(() => "?").join(",")})`).all(userId, kind, ...ids) as { targetId: string; at: string }[];
  return new Map(rows.map((r) => [r.targetId, r.at]));
}

/** One human's delta on one target: when they last opened it, last decided it, what they said about it, what they have not read. */
export interface ReaderDelta {
  /** the last time they opened the target (for a grant: the grant or any ask on it), or null */
  lastSeen: string | null;
  /** their latest decision on it (a grant's fund, counter, reject, continue, adjust, cut, close or stop), or null */
  lastDecided: { action: string; at: string; note: string } | null;
  /** their latest meeting lines about it, newest first (at most 3) */
  lastSaid: { meetingId: string; at: string; line: string }[];
  /** the target's reports they have never opened, oldest first */
  unreadReports: string[];
}

const DECISIONS = new Set<string>(["fund", "counter", "reject", "continue", "adjust", "cut", "close", "stop"]);
/** How many of the human's most recent meetings are searched for what they said. */
const MEETINGS_SEARCHED = 60;
const STOP = new Set(["about", "after", "their", "there", "these", "those", "which", "while", "where", "would", "could", "should", "every", "other", "being", "build", "makes", "using"]);

/** The objective's distinctive words: at least 5 letters, not a stop word. */
const keywords = (text: string) => [...new Set(text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [])].filter((w) => !STOP.has(w));

/** A line is about the target when it names its id, or (for a grant) two of its objective's distinctive words. */
function about(line: string, id: string, words: string[]): boolean {
  if (line.includes(id)) return true;
  const l = line.toLowerCase();
  return words.length >= 2 && words.filter((w) => l.includes(w)).length >= 2;
}

/**
 * The reader's delta of `userId` on a target (a grant, an ask or a report). For a grant: the last time they opened it or
 * one of its asks, their latest decision in its history, their meeting lines naming it (its id, or two words of its
 * objective; the last `MEETINGS_SEARCHED` meetings they spoke in), and the reports of its sessions and its checkpoint
 * they have never opened. For an ask or a report: when they opened it and what they said naming it.
 */
export function readerDelta(world: World, userId: string, target: { kind: SeenKind; id: string }): ReaderDelta {
  const grant = target.kind === "grant" ? world.grants.get(target.id) : undefined;
  const askIds = grant ? world.asks.where("targetKind = 'grant' AND targetId = ?", [grant.id]).map((a) => a.id) : [];
  const seen = [...seenAt(world, userId, target.kind, [target.id]).values(), ...seenAt(world, userId, "ask", askIds).values()].sort();
  const decided = grant ? [...grant.history].reverse().find((h) => h.byKind === "user" && h.byId === userId && DECISIONS.has(h.action)) : undefined;
  const words = grant ? keywords(grant.objective) : [];
  const meetings = world.meetings.where("transcript LIKE ?", [`%"${userId}"%`], `ORDER BY createdAt DESC LIMIT ${MEETINGS_SEARCHED}`);
  const lastSaid = meetings
    .flatMap((m) => m.transcript.filter((u) => u.speakerKind === "user" && u.speakerId === userId && about(u.text, target.id, words)).map((u) => ({ meetingId: m.id, at: u.at, line: u.text.replace(/\s+/g, " ").trim().slice(0, 200) })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);
  const reports = grant
    ? [...new Set([...world.assignments.where("grantId = ? AND reportId IS NOT NULL", [grant.id], "ORDER BY createdAt, rowid").map((a) => a.reportId!), ...(grant.checkpointDocId ? [grant.checkpointDocId] : [])])]
    : [];
  const read = seenAt(world, userId, "report", reports);
  return {
    lastSeen: seen.at(-1) ?? null,
    lastDecided: decided ? { action: decided.action, at: decided.at, note: decided.note } : null,
    lastSaid,
    unreadReports: reports.filter((id) => !read.has(id)),
  };
}

/** The human the asks are written for: the root goal's owner, else the collective's first admin (the captain). */
export function captainUserId(world: World): string | null {
  return world.goalTree.get(ROOT_GOAL_ID)?.ownerId ?? world.goalTree.firstAdminId();
}
