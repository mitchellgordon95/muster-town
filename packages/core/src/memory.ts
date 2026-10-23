/**
 * A resident's memory between sessions (docs/design.md, review 5): a **wiki** of topic pages it curates, and an
 * append-only **log** of durable events. Both are the agent's private drafts (doc types "wiki" and "log"), go into every
 * work session's system prompt, and show on the agent panel. Nothing survives a session except what the resident wrote
 * down, so there is no transcript to keep warm and no compactor deciding what matters.
 *
 * Also the manager's **team** block: who is in the building, what each one knows (wiki page titles) and is doing, so
 * the manager, the building's only conversational surface, can turn a human's request into the right assignment.
 */
import type { Agent, Building, Doc } from "@muster-town/schema";
import { createDoc, homeOf, updateDoc } from "./domain.ts";
import { docGist, oneLine, relativeTime } from "./text.ts";
import type { World } from "./world.ts";

/** Most chars of one wiki page shown in a prompt; the rest is cut with a note (the page itself stays whole). */
export const WIKI_PAGE_CAP = 2500;
/** Most chars of wiki bodies shown in a prompt in total; further pages are listed by title and gist. */
export const WIKI_TOTAL_CAP = 8000;
/** Log lines shown in a prompt. */
export const LOG_TAIL = 12;
/** Log lines kept in the doc; older ones fall off the top. */
export const LOG_MAX_LINES = 500;

/** Who a memory doc belongs to (an agent, or a visitor's owning user), with what createDoc needs. */
export interface MemoryOwner { id: string; kind: "agent" | "user"; name: string; buildingId: string | null; agentId: string | null }

export function ownerOf(agent: Agent, holder: { id: string; kind: "agent" | "user" }): MemoryOwner {
  return { id: holder.id, kind: holder.kind, name: agent.name, buildingId: homeOf(agent), agentId: holder.kind === "agent" ? agent.id : null };
}

/** The author's wiki pages, most recently updated first. */
export function wikiOf(world: World, authorId: string): Doc[] {
  return world.docs.where("authorId = ? AND type = 'wiki'", [authorId], "ORDER BY updatedAt DESC, rowid DESC");
}

/** One wiki page by topic (title, case-insensitive). */
export function wikiPage(world: World, authorId: string, title: string): Doc | undefined {
  return world.docs.first("authorId = ? AND type = 'wiki' AND lower(title) = lower(?)", [authorId, title.trim()]);
}

/** Create or rewrite the author's page on `title`: always a private draft, one per topic. */
export function writeWikiPage(world: World, who: MemoryOwner, title: string, body: string, id?: string): { doc: Doc; created: boolean } {
  const topic = title.trim();
  if (!topic) throw new Error("A wiki page needs a title: the topic it covers.");
  const byId = id ? world.docs.get(id) : undefined;
  const cur = byId && byId.authorId === who.id && byId.type === "wiki" ? byId : wikiPage(world, who.id, topic);
  if (cur) {
    const doc = updateDoc(world, cur.id, { title: topic, body, state: "draft" });
    world.events.append({ type: "doc.updated", agentId: who.agentId, buildingId: doc.buildingId, text: `${who.name} updated their wiki page "${topic}"`, payload: { docId: doc.id, wiki: true } });
    return { doc, created: false };
  }
  const doc = createDoc(world, { type: "wiki", state: "draft", title: topic, body, authorId: who.id, authorKind: who.kind, buildingId: who.buildingId }, `${who.name} started a wiki page "${topic}"`);
  return { doc, created: true };
}

/** The author's log (one per author), if any. */
export function logOf(world: World, authorId: string): Doc | undefined {
  return world.docs.first("authorId = ? AND type = 'log'", [authorId], "ORDER BY createdAt ASC, rowid ASC");
}

/** `- 2026-10-23 03:55 <text>` */
export function logLine(text: string, now = Date.now()): string {
  return `- ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} ${oneLine(text, 400)}`;
}

/** Append one dated line to the author's log (created on first use); keeps the last LOG_MAX_LINES. */
export function appendLog(world: World, who: MemoryOwner, text: string, now = Date.now()): Doc {
  const line = logLine(text, now);
  const cur = logOf(world, who.id);
  if (cur) {
    const lines = cur.body.split("\n").filter((l) => l.trim());
    lines.push(line);
    return updateDoc(world, cur.id, { body: lines.slice(-LOG_MAX_LINES).join("\n"), state: "draft" });
  }
  return createDoc(world, { type: "log", state: "draft", title: `${who.name}'s log`, body: line, authorId: who.id, authorKind: who.kind, buildingId: who.buildingId }, `${who.name} started a log`);
}

/** The last `n` log lines, oldest first. */
export function logTail(log: Doc | undefined | null, n = LOG_TAIL): string[] {
  const lines = (log?.body ?? "").split("\n").filter((l) => l.trim());
  return lines.slice(-n);
}

export const WIKI_HOWTO = `Your memory between sessions is your wiki and your log. The wiki is a set of topic pages (\`write\` type "wiki", title = the topic, e.g. "The Bank"): before \`submit_report\`, rewrite the pages for every topic you worked on and start pages for new ones; keep a page under half a page, state what is true now and the ids of the documents behind it, and rewrite rather than append. The log is append-only (\`write\` type "log", one line): record decisions and things shipped; your assignments and reports are logged for you.`;

/**
 * "## What you know" (wiki pages, newest first, whole up to the caps, then by title and gist) and "## Your log"
 * (the last LOG_TAIL lines). Pages and log are the agent's own, so the author id is the agent's (or its owner's).
 */
export function memoryBlock(world: World, authorId: string, opts: { now?: number; pageCap?: number; totalCap?: number; tail?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const pageCap = opts.pageCap ?? WIKI_PAGE_CAP, totalCap = opts.totalCap ?? WIKI_TOTAL_CAP;
  const pages = wikiOf(world, authorId);
  const out: string[] = ["## What you know (your wiki)"];
  if (!pages.length) {
    out.push(`(no pages yet. Before \`submit_report\`, write one page per topic you worked on: \`write\` type "wiki", title = the topic.)`);
  } else {
    let used = 0;
    const listed: string[] = [];
    for (const p of pages) {
      const body = p.body.trim();
      if (used + Math.min(body.length, pageCap) <= totalCap) {
        const shown = body.length > pageCap ? `${body.slice(0, pageCap)}\n…(page is ${body.length} chars; \`read\` ${p.id} for the rest, and shorten it)` : body;
        out.push(`\n### ${p.title} (${p.id}, updated ${relativeTime(p.updatedAt, now)})\n${shown}`);
        used += Math.min(body.length, pageCap);
      } else {
        listed.push(`- "${p.title}" (${p.id}, ${relativeTime(p.updatedAt, now)}): ${docGist(p)}`);
      }
    }
    if (listed.length) out.push(`\nOther pages (\`read\` the ones that matter):\n${listed.join("\n")}`);
  }
  const log = logOf(world, authorId);
  const total = log ? log.body.split("\n").filter((l) => l.trim()).length : 0;
  const tail = logTail(log, opts.tail ?? LOG_TAIL);
  out.push(`\n## Your log${total > tail.length ? ` (last ${tail.length} of ${total}${log ? `; \`read\` ${log.id} for all` : ""})` : ""}`);
  out.push(tail.length ? tail.join("\n") : "(empty)");
  return out.join("\n");
}

/** Titles of the author's wiki pages (what they know), newest first. */
export function topicsOf(world: World, authorId: string): string[] {
  return wikiOf(world, authorId).map((p) => p.title);
}

/**
 * "## Your team": for a building's manager agent, every active resident with status, queue, current work and wiki
 * topics, plus the rule that makes the manager the building's conversational surface.
 */
export function teamBlock(world: World, building: Building, managerId: string): string {
  const residents = world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('retired', 'banned')", [building.id], "ORDER BY name");
  const lines = residents.filter((a) => a.id !== managerId).map((a) => {
    const queued = world.assignments.count("agentId = ? AND status = 'pending'", [a.id]);
    const cur = a.currentAssignmentId ? world.assignments.get(a.currentAssignmentId) : undefined;
    const doing = a.status === "working" && cur ? ` on "${oneLine(cur.title, 60)}"` : "";
    const topics = topicsOf(world, a.id);
    return `- ${a.name} (${a.id}): ${a.status}${doing}, ${queued} queued; knows: ${topics.length ? topics.slice(0, 12).join(", ") : "(no wiki pages yet)"}`;
  });
  return `## Your team (you are the manager of the ${building.name})
Humans talk to you; residents don't take messages, they work from assignments. When a human writes to you, reply with \`tell\` first, then turn what they want into assignments with \`assign\`: pick the resident whose wiki covers the topic (a resident with no page on it starts from the reports), one owner per piece of work, and say in your report who got what. Do the work yourself only when it is yours.
${lines.length ? lines.join("\n") : "(no other residents yet)"}`;
}
