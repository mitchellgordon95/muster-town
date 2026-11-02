/**
 * Folding "go fund gr_xxx" rollups into the item's own in-tray row (Mitchell, 1:1 mt_7b4zc7yja3: "it's irritating to
 * have reports that basically say 'go look at your grants and fund gr_xxxx'"). A decision that already has its own
 * Town Hall in-tray row (a grant proposal, a checkpoint, a grant closed as done, a retainer ask) carries the asks of the
 * rollups that name it (`asks` on the row, `RollupAsk`), and a rollup that asks nothing else is acknowledged when it is
 * filed (`foldRollup`, tag "folded") instead of becoming a card of its own.
 */
import { askLineFor, type Doc, type GrantView, type RollupAsk, type ScheduleView } from "@muster-town/schema";
import { grantsAwaitingDecision, updateDoc } from "./domain.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** Ids of the items waiting for a human on their own Town Hall in-tray row (countered proposals wait on the manager). */
export function waitingRowIds(world: World): Set<string> {
  const ids = new Set(grantsAwaitingDecision(world).filter((g) => g.status !== "countered").map((g) => g.id));
  for (const s of world.schedules.where("status = 'active' AND retainer = 'asked'")) ids.add(s.id);
  return ids;
}

/** When the item's current ask began: a grant's latest propose / checkpoint / close, a retainer's creation. */
function askedSince(item: GrantView | ScheduleView): string {
  if ("history" in item) return [...item.history].reverse().find((h) => h.action === "propose" || h.action === "checkpoint" || h.action === "close")?.at ?? item.createdAt;
  return item.createdAt;
}

/**
 * The rollups asking about one item since its current ask began, oldest first: pending ones (still a card when they
 * carry more) and folded ones (acknowledged on submit). The generated waiting line doesn't count as asking.
 */
export function rollupAsksFor(world: World, item: GrantView | ScheduleView): RollupAsk[] {
  const like = `%${item.id}%`;
  const docs = world.docs.where(
    "type = 'report' AND tags LIKE '%\"rollup\"%' AND (decision = 'pending' OR tags LIKE '%\"folded\"%') AND createdAt >= ? AND (body LIKE ? OR title LIKE ?)",
    [askedSince(item), like, like], "ORDER BY createdAt, rowid",
  );
  return docs.flatMap((d) => {
    const line = askLineFor(d.title, d.body, item.id);
    return line ? [{ reportId: d.id, buildingId: d.buildingId, buildingName: world.buildings.get(d.buildingId ?? "")?.name ?? "Town", title: d.title, line, at: d.createdAt, folded: d.tags.includes("folded") }] : [];
  });
}

/** The item with its rollup asks attached (`asks`), unchanged when none names it. */
export function withAsks<T extends GrantView | ScheduleView>(world: World, item: T): T {
  const asks = rollupAsksFor(world, item);
  return asks.length ? { ...item, asks } : item;
}

/**
 * Acknowledge a just-filed rollup whose only asks are on items with their own in-tray rows (`waiting`): decision
 * "approve" by the system, a note naming those items, tag "folded". It is no Town Hall card; each row shows its ask.
 */
export function foldRollup(world: World, doc: Doc, waiting: string[]): Doc {
  const note = `Folded into the in-tray row${waiting.length === 1 ? "" : "s"} of ${waiting.join(", ")}: its ask shows there (1:1 mt_7b4zc7yja3).`;
  const folded = updateDoc(world, doc.id, { decision: "approve", decidedBy: "system", decidedAt: nowIso(), decisionNote: note, tags: [...doc.tags, "folded"] });
  world.events.append({
    type: "doc.decision", agentId: doc.authorId, buildingId: doc.buildingId, text: `Folded: "${doc.title}" asks only about ${waiting.join(", ")}`,
    payload: { docId: doc.id, decision: "approve", note, decidedBy: "system", folded: waiting },
  });
  return folded;
}
