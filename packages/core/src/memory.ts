/**
 * A resident's memory between sessions (docs/design.md, review 5): a **wiki** of topic pages it curates, and an
 * append-only **log** of durable events. Both are the agent's private drafts (doc types "wiki" and "log"), go into every
 * work session's system prompt, and show on the agent panel. Nothing survives a session except what the resident wrote
 * down, so there is no transcript to keep warm and no compactor deciding what matters.
 *
 * Also the manager's **team** block: who is in the building, what each one knows (wiki page titles) and is doing, so
 * the manager, the building's only conversational surface, can turn a human's request into the right assignment.
 */
import type { Agent, Assignment, Building, Doc } from "@muster-town/schema";
import { buildingQueue, createDoc, homeOf, updateDoc } from "./domain.ts";
import { AppError } from "./errors.ts";
import { scheduledAt } from "./blockers.ts";
import { reportChain } from "./forks.ts";
import { docGist, ftsQuery, oneLine, relativeTime } from "./text.ts";
import { nowIso } from "./util.ts";
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

/** The author's private wiki pages (not the topic pages they wrote), most recently updated first. */
export function wikiOf(world: World, authorId: string): Doc[] {
  return world.docs.where("authorId = ? AND type = 'wiki' AND topicOf IS NULL", [authorId], "ORDER BY updatedAt DESC, rowid DESC");
}

/** One private wiki page by topic (title, case-insensitive). */
export function wikiPage(world: World, authorId: string, title: string): Doc | undefined {
  return world.docs.first("authorId = ? AND type = 'wiki' AND topicOf IS NULL AND lower(title) = lower(?)", [authorId, title.trim()]);
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

// ---------- topic pages (manager forks step 4, dc_mymt27yz25 §5.1) ----------

/** Most chars of the manager's private wiki in a fork's memory block. */
export const FORK_MANAGER_WIKI_CAP = 3000;
/** Topic pages listed in the index; the rest are found with `search` type wiki. */
export const TOPIC_INDEX_MAX = 50;
/** Most topic pages a manager attaches to one assignment (`assign … pages`). */
export const MAX_ATTACHED_PAGES = 3;

/** One stored revision: the body a rewrite replaced. authorId wrote that body; replacedBy rewrote it. */
export interface DocRevision { id: number; docId: string; title: string; body: string; authorId: string; replacedBy: string; createdAt: string }

/** The building's topic pages (building-owned wiki pages), most recently touched first. */
export function topicPages(world: World, buildingId: string): Doc[] {
  return world.docs.where("type = 'wiki' AND topicOf = ?", [buildingId], "ORDER BY updatedAt DESC, rowid DESC");
}

/** One topic page of the building by title (case-insensitive). */
export function topicPage(world: World, buildingId: string, title: string): Doc | undefined {
  return world.docs.first("type = 'wiki' AND topicOf = ? AND lower(title) = lower(?)", [buildingId, title.trim()]);
}

/** Who may rewrite the building's topic pages: its manager agent and the manager's live forks. */
export function canWriteTopic(world: World, agent: Agent, buildingId: string): boolean {
  const b = world.buildings.get(buildingId);
  if (!b?.managerAgentId) return false;
  if (agent.id === b.managerAgentId) return true;
  return !!agent.forkOf && agent.forkOf === b.managerAgentId && agent.status !== "retired" && agent.homeBuildingId === buildingId;
}

/** The revisions of a doc (the bodies its rewrites replaced), oldest first. */
export function revisionsOf(world: World, docId: string): DocRevision[] {
  return world.db.prepare("SELECT id, docId, title, body, authorId, replacedBy, createdAt FROM doc_revisions WHERE docId = ? ORDER BY id").all(docId) as DocRevision[];
}

/** Who wrote the doc's current body: the last rewriter, else its author. */
export function lastWriterOf(world: World, doc: Doc): string {
  const r = world.db.prepare("SELECT replacedBy FROM doc_revisions WHERE docId = ? ORDER BY id DESC LIMIT 1").get(doc.id) as { replacedBy: string } | undefined;
  return r?.replacedBy ?? doc.authorId;
}

/**
 * Create or rewrite the building's topic page on `title` (or the page `id`): published in the building, one per title.
 * A rewrite stores the old title and body in doc_revisions first. Only the manager and its live forks write here.
 */
export function writeTopicPage(world: World, agent: Agent, buildingId: string, title: string, body: string, id?: string): { doc: Doc; created: boolean } {
  const topic = title.trim();
  if (!topic) throw new AppError("bad_request", "A topic page needs a title: the topic it covers.");
  if (!canWriteTopic(world, agent, buildingId)) throw new AppError("forbidden", "Only the building's manager and its forks write its topic pages (topicOf).");
  const byId = id ? world.docs.get(id) : undefined;
  if (id && !(byId && byId.type === "wiki" && byId.topicOf === buildingId)) throw new AppError("not_found", `No topic page ${id} in this building.`);
  const cur = byId ?? topicPage(world, buildingId, topic);
  if (cur) {
    return world.transaction(() => {
      world.db.prepare("INSERT INTO doc_revisions (docId, title, body, authorId, replacedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(cur.id, cur.title, cur.body, lastWriterOf(world, cur), agent.id, nowIso());
      const doc = updateDoc(world, cur.id, { title: topic, body, state: "building" });
      world.events.append({ type: "doc.updated", agentId: agent.id, buildingId, text: `${agent.name} rewrote the topic page "${topic}"`, payload: { docId: doc.id, wiki: true, topicOf: buildingId } });
      return { doc, created: false };
    });
  }
  const doc = createDoc(world, { type: "wiki", state: "building", title: topic, body, authorId: agent.id, authorKind: "agent", buildingId, topicOf: buildingId }, `${agent.name} started the topic page "${topic}"`);
  return { doc, created: true };
}

/** "- "title" (id, age): gist" for one topic page. */
function topicLine(p: Doc, now: number): string {
  return `- "${p.title}" (${p.id}, ${relativeTime(p.updatedAt, now)}): ${oneLine(docGist(p), 80)}`;
}

/**
 * "## Topic pages": the building's shared wiki by title, id, age and a one-line gist, the TOPIC_INDEX_MAX most recently
 * touched (plus a search pointer for the rest). Empty string when the building has none.
 */
export function topicIndexBlock(world: World, buildingId: string, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const pages = topicPages(world, buildingId);
  if (!pages.length) return "";
  const shown = pages.slice(0, TOPIC_INDEX_MAX);
  const more = pages.length > shown.length ? `\n(${pages.length - shown.length} more: \`search\` type wiki for the rest)` : "";
  return `## Topic pages (the building's shared wiki; \`read\` the ones that matter)\n${shown.map((p) => topicLine(p, now)).join("\n")}${more}`;
}

/** The topic pages for a fork's assignment: the attached ones, else the 2 whose titles best match its title (FTS). */
export function pagesForAssignment(world: World, buildingId: string, assignment: Assignment | null | undefined): Doc[] {
  if (!assignment) return [];
  if (assignment.pages?.length) return assignment.pages.map((id) => world.docs.get(id)).filter((d): d is Doc => !!d && d.topicOf === buildingId);
  const q = ftsQuery(assignment.title);
  if (!q) return [];
  try {
    return world.docs.query("SELECT d.* FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid WHERE docs_fts MATCH ? AND d.type = 'wiki' AND d.topicOf = ? ORDER BY bm25(docs_fts, 3.0, 1.0) LIMIT 2", [q, buildingId]);
  } catch { return []; }
}

/**
 * A fork's memory (dc_mymt27yz25 §5.2), frozen into its prompt at spawn. Under WIKI_TOTAL_CAP in total: (1) the
 * manager's private wiki, cut at FORK_MANAGER_WIKI_CAP, (2) the assignment's topic pages, each cut at WIKI_PAGE_CAP,
 * (3) the topic index if it still fits, else a search pointer. Outside the cap: the manager's log tail (the fork's own
 * log lines land there).
 */
export function forkMemoryBlock(world: World, fork: Agent, assignment?: Assignment | null, opts: { now?: number; totalCap?: number; pageCap?: number; managerCap?: number; tail?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const totalCap = opts.totalCap ?? WIKI_TOTAL_CAP, pageCap = opts.pageCap ?? WIKI_PAGE_CAP, managerCap = opts.managerCap ?? FORK_MANAGER_WIKI_CAP;
  const manager = world.agents.require(fork.forkOf!, "agent");
  const bid = fork.homeBuildingId ?? manager.homeBuildingId ?? "";
  const out: string[] = [];
  let used = 0;
  // (1) what the manager knows
  const own = wikiOf(world, manager.id).map((p) => `### ${p.title} (updated ${relativeTime(p.updatedAt, now)})\n${p.body.trim()}`).join("\n\n");
  const ownShown = own.length > managerCap ? `${own.slice(0, managerCap)}\n…(${manager.name}'s wiki is ${own.length.toLocaleString("en-US")} chars; cut at ${managerCap.toLocaleString("en-US")}. It is ${manager.name}'s, read-only for you.)` : own;
  out.push(`## What ${manager.name} knows (${manager.name}'s private wiki; read-only)\n${ownShown || "(no pages)"}`);
  used += Math.min(own.length, managerCap);
  // (2) the assignment's topic pages
  const pages = pagesForAssignment(world, bid, assignment);
  const attached = !!assignment?.pages?.length;
  if (pages.length) {
    out.push(`\n## Topic pages for this work (${attached ? "attached by your manager" : "best title match"})`);
    for (const p of pages) {
      const body = p.body.trim();
      const room = Math.min(pageCap, Math.max(0, totalCap - used));
      if (room < 200) { out.push(`- "${p.title}" (${p.id}): \`read\` it`); continue; }
      const shown = body.length > room ? `${body.slice(0, room)}\n…(page is ${body.length} chars; \`read\` ${p.id} for the rest)` : body;
      out.push(`\n### ${p.title} (${p.id}, updated ${relativeTime(p.updatedAt, now)})\n${shown}`);
      used += Math.min(body.length, room);
    }
  }
  // (3) the index, if it fits
  const index = topicIndexBlock(world, bid, { now });
  if (index && used + index.length <= totalCap) out.push(`\n${index}`);
  else if (index) out.push("\n## Topic pages\nThe building has more topic pages: `search` type wiki to find them.");
  out.push(`\n${FORK_MEMORY_RULE}`);
  // outside the cap: the manager's log, the building's journal
  const log = logOf(world, manager.id);
  const total = log ? log.body.split("\n").filter((l) => l.trim()).length : 0;
  const tail = logTail(log, opts.tail ?? LOG_TAIL);
  out.push(`\n## ${manager.name}'s log${total > tail.length ? ` (last ${tail.length} of ${total})` : ""}`);
  out.push(tail.length ? tail.join("\n") : "(empty)");
  return out.join("\n");
}

export const FORK_MEMORY_RULE = `You are a fork: you have no private wiki. What you learn goes into topic pages (\`write\` type "wiki" with topicOf = your building id; same title rewrites the page, every rewrite is kept) or skills, and \`write\` type "log" lines go to your manager's log. Put only verified state on a topic page ("pushed X, seen on origin/main"), with the ids of the documents behind it.`;

/** Where an agent's log lines go: its own log, or for a fork its manager's, prefixed "[<fork name>] ". */
export function logTargetOf(world: World, agent: Agent, holder: { id: string; kind: "agent" | "user" }): { owner: MemoryOwner; prefix: string } {
  if (agent.forkOf) {
    const m = world.agents.get(agent.forkOf);
    if (m) return { owner: ownerOf(m, { id: m.id, kind: "agent" }), prefix: `[${agent.name}] ` };
  }
  return { owner: ownerOf(agent, holder), prefix: "" };
}

/** Append a line to the agent's log (a fork's goes to its manager's log as "[Pix 3] …"). */
export function appendAgentLog(world: World, agent: Agent, text: string, now = Date.now()): Doc {
  const { owner, prefix } = logTargetOf(world, agent, world.holderOf(agent));
  return appendLog(world, owner, `${prefix}${text}`, now);
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
  if (building.forks) return forkTeamBlock(world, building, managerId);
  const residents = world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('retired', 'banned') AND forkOf IS NULL", [building.id], "ORDER BY name");
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

/**
 * "## Your team" when the building has forks on (design note dc_mymt27yz25 §5): work goes on the building queue and a
 * fork of the manager runs it, so instead of per-resident queues it lists the live forks and the building queue
 * (pending, held, waiting, scheduled: a time still ahead, not a block), and the routing rule is "attach the topic pages that cover it", not "pick the resident".
 */
export function forkTeamBlock(world: World, building: Building, managerId: string): string {
  const forks = world.agents.where("forkOf = ? AND status NOT IN ('retired', 'banned')", [managerId], "ORDER BY forkN");
  const forkLines = forks.map((f) => {
    const cur = f.currentAssignmentId ? world.assignments.get(f.currentAssignmentId) : undefined;
    const chain = cur ? reportChain(world, { id: "", assignmentId: cur.id, createdAt: cur.createdAt }) : null;
    return `- ${f.name} (${f.id}): ${f.status}${cur ? ` on "${oneLine(cur.title, 60)}" (${cur.id})` : ""}${chain ? ` · chain ${chain.chainId} · hop ${chain.hop}` : ""}`;
  });
  const queue = buildingQueue(world, building.id);
  const kind = (a: Assignment) => a.heldReason ? "held" : scheduledAt(a) ? "scheduled" : a.waitFor ? "waiting" : "pending";
  const state = (a: Assignment) => ({ held: `held: ${oneLine(a.heldReason ?? "", 60)}`, scheduled: `scheduled: runs at ${scheduledAt(a)?.slice(0, 16).replace("T", " ")} UTC`, waiting: `waiting: ${oneLine(JSON.stringify(a.waitFor), 60)}`, pending: "pending" })[kind(a)];
  const counts = { pending: 0, held: 0, waiting: 0, scheduled: 0 };
  for (const a of queue) counts[kind(a)]++;
  const queueLines = queue.slice(0, 12).map((a) => `- ${a.id} "${oneLine(a.title, 60)}": ${state(a)}`);
  if (queue.length > 12) queueLines.push(`- … and ${queue.length - 12} more`);
  return `## Your team (you are the manager of the ${building.name}; forks are on)
Humans talk to you; forks don't take messages, they work from assignments. When a human writes to you, reply with \`tell\` first, then turn what they want into assignments with \`assign\` and no agentId: it goes on the building queue and a fork of you runs it. Attach the topic pages that cover it (\`assign\` pages, at most 3) so the fork starts from what the building knows; one assignment per piece of work, and say in your report what went on the queue. Do the work yourself only when it is yours.
Live forks (${forks.length}):
${forkLines.length ? forkLines.join("\n") : "(none running)"}
Building queue (${counts.pending} pending, ${counts.held} held, ${counts.waiting} waiting, ${counts.scheduled} scheduled):
${queueLines.length ? queueLines.join("\n") : "(empty)"}`;
}
