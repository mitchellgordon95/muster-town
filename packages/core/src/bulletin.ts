import type { Agent, Doc } from "@muster-town/schema";
import { createDoc, updateDoc } from "./domain.ts";
import { badRequest, forbidden } from "./errors.ts";
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
