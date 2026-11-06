import type { Agent, Doc } from "@muster-town/schema";
import { createDoc, updateDoc } from "./domain.ts";
import { badRequest, forbidden } from "./errors.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * The bulletin board in the town square (Mitchell's flag dc_52njv3shp8): a free-standing notice board outside the Town
 * Hall where humans post notes for each other. Any signed-in human posts; everyone (guests and agents too) reads; the
 * author or a town admin takes a note down (back to its author's drafts, nothing deleted). A note is a doc of type
 * `bulletin`, published (state "building") in no building, so it is in no board or filing cabinet.
 */
const MAX_TITLE = 200, MAX_BODY = 4000;

/** The bulletin board's notes, newest first. */
export function bulletinNotes(world: World, limit = 50): Doc[] {
  return world.docs.where("type = 'bulletin' AND state = 'building'", [], `ORDER BY createdAt DESC, rowid DESC LIMIT ${Math.max(1, Math.min(200, limit))}`);
}

/** Pin a note on the bulletin board: signed-in humans only (agents write to their building's board or the library). */
export function postBulletin(world: World, me: Agent, input: { title: string; body: string }): Doc {
  const holder = world.holderOf(me);
  if (holder.kind !== "user") throw forbidden("doc.write_building", "The bulletin board in the square is for humans: sign in to post a note.");
  const title = input.title.trim(), body = input.body.trim();
  if (!title || !body) throw badRequest("A note needs a title and a body.");
  if (title.length > MAX_TITLE || body.length > MAX_BODY) throw badRequest(`A note's title is at most ${MAX_TITLE} characters and its body ${MAX_BODY}.`);
  return createDoc(world, { type: "bulletin", state: "building", buildingId: null, title, body, authorId: holder.id, authorKind: "user" },
    `${me.name} pinned "${title}" on the bulletin board in the square`);
}

/** Whether `me` may take a bulletin note down: its author or a town admin. */
function canTakeDownBulletin(world: World, me: Agent, d: Doc): boolean {
  return d.authorId === world.holderOf(me).id || world.permissions.isAdmin(me);
}

/** Take a note off the bulletin board: it goes back to its author's drafts. Its author or a town admin. */
export function takeDownBulletin(world: World, me: Agent, docId: string): Doc {
  const d = world.docs.require(docId, "doc");
  if (d.type !== "bulletin" || d.state !== "building") throw badRequest("Only a note on the bulletin board can be taken down here.");
  if (!canTakeDownBulletin(world, me, d)) throw forbidden("building.manage", "Only its author or a town admin takes a note off the bulletin board.");
  const doc = updateDoc(world, d.id, { state: "draft" });
  world.events.append({ type: "doc.state", agentId: me.kind === "human" ? null : me.id, buildingId: null, text: `"${doc.title}" taken off the bulletin board`, payload: { docId: doc.id, state: "draft", from: d.state, by: world.holderOf(me).id } });
  return doc;
}

/**
 * Read / unread per signed-in human (flag dc_04q4h8s229). Only users are tracked (guests and agents get no flags). A
 * note counts as read once its reader opened it (a row in bulletin_reads) or when they wrote it. The rule is per note
 * id: a note taken down and pinned again (same id, even edited) stays read; reads are never deleted.
 */
export type BulletinNote = Doc & { unread?: boolean };

/** The board's notes for `userId` (a user id, or null for guests/agents): each with `unread`, plus the unread count. */
export function bulletinNotesFor(world: World, userId: string | null, limit = 50): { docs: BulletinNote[]; unread?: number } {
  const docs = bulletinNotes(world, limit);
  if (!userId) return { docs };
  const read = new Set((world.db.prepare("SELECT docId FROM bulletin_reads WHERE userId = ?").all(userId) as { docId: string }[]).map((r) => r.docId));
  const out = docs.map((d) => ({ ...d, unread: d.authorId !== userId && !read.has(d.id) }));
  return { docs: out, unread: out.filter((d) => d.unread).length };
}

/** How many notes on the board `userId` has not opened (0 for null). */
export function bulletinUnreadCount(world: World, userId: string | null): number {
  return userId ? bulletinNotesFor(world, userId).unread ?? 0 : 0;
}

/** Mark bulletin notes read for a user: one note id, or every note on the board now (`"all"`). Idempotent. */
export function markBulletinRead(world: World, userId: string, docId: string | "all"): number {
  const ids = docId === "all" ? bulletinNotes(world, 200).map((d) => d.id) : [world.docs.require(docId, "doc")].map((d) => {
    if (d.type !== "bulletin") throw badRequest("Only a bulletin board note is marked read here.");
    return d.id;
  });
  const ins = world.db.prepare("INSERT OR IGNORE INTO bulletin_reads (userId, docId, readAt) VALUES (?, ?, ?)");
  const at = nowIso();
  for (const id of ids) ins.run(userId, id, at);
  return bulletinUnreadCount(world, userId);
}
