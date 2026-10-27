/**
 * `@Name` mentions in docs, reports, meeting utterances, `say` and `tell`.
 * A mention puts a `mention` message in the mentioned agent's inbox (a human's avatar gets one too; the web shows it
 * from the `agent.mentioned` event). It never starts work by itself: it's a request to look.
 */
import type { Agent, Message } from "@muster-town/schema";
import { sendMessage } from "./domain.ts";
import { actOrigin } from "./origin.ts";
import { holderOf, type Holder } from "./permissions.ts";
import { truncate } from "./util.ts";
import type { World } from "./world.ts";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Index of the first `@Name` for this name in text (case-insensitive, word-bounded on both sides), or -1. */
function mentionIndex(text: string, name: string): number {
  if (!name.trim()) return -1;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@.])@${escapeRe(name.trim())}(?![\\p{L}\\p{N}_])`, "iu");
  return re.exec(text)?.index ?? -1;
}

/**
 * Agents mentioned as `@Name` in text: non-retired, non-banned agents of this collective (one world = one collective),
 * deduped, in order of first mention. `exclude` holds the author's ids (agent id and/or user id); an excluded user id
 * also excludes that user's avatar.
 */
export function extractMentions(text: string, world: World, exclude: Iterable<string> = []): Agent[] {
  if (!text.includes("@")) return [];
  const skip = new Set(exclude);
  const found: { agent: Agent; at: number }[] = [];
  const seen = new Set<string>();
  for (const a of world.agents.where("status NOT IN ('retired','banned')", [])) {
    if (skip.has(a.id) || skip.has(holderOf(a).id) || seen.has(a.id)) continue;
    const at = mentionIndex(text, a.name);
    if (at < 0) continue;
    seen.add(a.id);
    found.push({ agent: a, at });
  }
  return found.sort((x, y) => x.at - y.at).map((f) => f.agent);
}

export interface MentionContext {
  /** what the mention is in, e.g. `report "Q3 trend"`, `meeting "Weekly"`, `speech` */
  where: string;
  docId?: string | null;
  meetingId?: string | null;
  buildingId?: string | null;
  /** agents who already get the text another way (a `tell` recipient) */
  skip?: string[];
  /** don't notify humans (a resident's report in a building whose manager agent works the in-tray) */
  agentsOnly?: boolean;
}

/** Excerpt (≤200 chars) of text around the first mention of `name`. */
function excerptAround(text: string, name: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = Math.max(0, mentionIndex(flat, name));
  const start = at > 60 ? at - 40 : 0;
  return truncate((start > 0 ? "…" : "") + flat.slice(start), 200);
}

/**
 * Notify every agent mentioned in `text` by `author` (the acting agent or avatar). Returns the messages sent.
 * Pass `previousText` on doc updates so only newly added mentions notify.
 */
export function notifyMentions(world: World, author: Agent, text: string, ctx: MentionContext, previousText?: string): Message[] {
  const by: Holder = holderOf(author);
  const exclude = [author.id, by.id, ...(ctx.skip ?? [])];
  const already = new Set(previousText ? extractMentions(previousText, world, exclude).map((a) => a.id) : []);
  const sent: Message[] = [];
  const origin = actOrigin(world, author, ctx.docId ?? ctx.meetingId ?? null);
  for (const target of extractMentions(text, world, exclude)) {
    if (already.has(target.id)) continue;
    if (ctx.agentsOnly && target.kind === "human") continue;
    const body = `${author.name} mentioned you in ${ctx.where}: ${excerptAround(text, target.name)}`;
    const msg = sendMessage(world, { kind: "mention", fromId: by.id, fromKind: by.kind, toId: target.id, body, docId: ctx.docId ?? null, meetingId: ctx.meetingId ?? null, origin });
    world.events.append({
      type: "agent.mentioned", agentId: target.id, buildingId: ctx.buildingId ?? target.homeBuildingId ?? target.buildingId,
      text: body,
      payload: { byId: by.id, byKind: by.kind, toId: target.id, toKind: target.kind, messageId: msg.id, ...(ctx.docId ? { docId: ctx.docId } : {}), ...(ctx.meetingId ? { meetingId: ctx.meetingId } : {}), origin },
    });
    sent.push(msg);
  }
  return sent;
}

/** `kind "title"` label for a doc mention. */
export const docWhere = (d: { type: string; title: string }) => `${d.type} "${d.title}"`;
