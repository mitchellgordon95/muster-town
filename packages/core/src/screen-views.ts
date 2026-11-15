/**
 * The human's screen time on decision-queue items (grant gr_pdja05z2f1 step 1; migration 116). The queue PUTs the item
 * on screen as its 1:1's focus (`setMeetingFocus`): each change closes the human's open view in that 1:1 and opens one
 * on the new item; the same item again writes nothing; null and the 1:1's end close it. Views are recorded whatever the
 * meeting's phase (the focus itself is only kept while it is discussing). A view never closed (the tab was shut, no null
 * reached the server) stays open in the table and is capped at `VIEW_CAP_MS` when read, never rewritten.
 */
import type { MeetingFocusKind } from "@muster-town/schema";
import type { World } from "./world.ts";

/** The longest a single view counts for: a view left open past it is an idle tab, not a human reading. */
export const VIEW_CAP_MS = 30 * 60 * 1000;

interface ViewRow { id: number; userId: string; kind: MeetingFocusKind; itemId: string; meetingId: string; openedAt: string; closedAt: string | null }

/** One view as read: its minutes on screen, capped at `VIEW_CAP_MS`, and whether it was still open (or left open) at the read. */
export interface ScreenView extends ViewRow { ms: number; open: boolean }

const openRow = (world: World, meetingId: string, userId: string) =>
  world.db.prepare("SELECT * FROM screen_views WHERE meetingId = ? AND userId = ? AND closedAt IS NULL ORDER BY id DESC LIMIT 1").get(meetingId, userId) as ViewRow | undefined;

/** Close the human's open view in a 1:1 (all of them when `userId` is left out, e.g. the 1:1 ended). */
export function closeScreenViews(world: World, meetingId: string, now: string, userId?: string): void {
  if (userId) world.db.prepare("UPDATE screen_views SET closedAt = ? WHERE meetingId = ? AND userId = ? AND closedAt IS NULL").run(now, meetingId, userId);
  else world.db.prepare("UPDATE screen_views SET closedAt = ? WHERE meetingId = ? AND closedAt IS NULL").run(now, meetingId);
}

/** The human has `item` on screen in the 1:1 now (null: nothing). The same item as the open view writes nothing. */
export function recordScreenView(world: World, userId: string, meetingId: string, item: { kind: MeetingFocusKind; id: string } | null, now: string): void {
  const cur = openRow(world, meetingId, userId);
  if (item && cur?.kind === item.kind && cur.itemId === item.id) return;
  if (cur) closeScreenViews(world, meetingId, now, userId);
  if (item) world.db.prepare("INSERT INTO screen_views (userId, kind, itemId, meetingId, openedAt) VALUES (?, ?, ?, ?, ?)").run(userId, item.kind, item.id, meetingId, now);
}

/** The views opened since `since` (ISO), oldest first, each with its capped time on screen at `now`. */
export function screenViews(world: World, since: string, now: Date = new Date()): ScreenView[] {
  const rows = world.db.prepare("SELECT * FROM screen_views WHERE openedAt >= ? ORDER BY openedAt, id").all(since) as ViewRow[];
  const t = now.getTime();
  return rows.map((r) => ({ ...r, open: !r.closedAt, ms: Math.max(0, Math.min(VIEW_CAP_MS, (r.closedAt ? Date.parse(r.closedAt) : t) - Date.parse(r.openedAt))) }));
}
