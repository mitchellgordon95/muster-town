/**
 * The review deck (design dc_y7a8g257of §2, gr_jh0lu0w6yj step 4): the Town Hall in-tray as slides, assembled in code
 * on every GET /api/review-deck (zero tokens, always current). Slide 1 is the state of the town; then one slide per
 * pending decision, blocking-most first:
 *   1. checkpoint grants held · 2. blocked buildings · 3. items work is parked on (most waiters first) ·
 *   4. grant proposals, oldest first, then goal proposals (docs/goals.md step 4) · 5. rollups with a real "Your call" (one slide per such item), and other reports ·
 *   6. grants closed as done whose key result needs met or missed · then one "For the record" slide for rollups whose
 *   every call is None.
 * Each slide says how long it has waited and how many assignments are parked on it, and carries one history line when
 * one applies (a grant's last human entry; the building's previous rollup decision; a meeting with a human its
 * provenance names).
 */
import { ROOT_GOAL_ID, isNoCall, parseRollup, type Doc, type GrantView, type Meeting, type PinnedSlide, type ReviewDeck, type ReviewSlide, type ReviewSlideKind, type RollupItem } from "@muster-town/schema";
import { grantsAwaitingDecision, townHallIntray } from "./domain.ts";
import { freeTokens } from "./free-tokens.ts";
import type { GoalNode, GoalProposalView } from "./goals.ts";
import type { World } from "./world.ts";

const H = 3_600_000;
const FLAG_AFTER_MS = 2 * H;
const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
import { waitedFor } from "./time.ts";
;
const KR_LIGHT: Record<string, string> = { "not-started": "⚪", "on-track": "🟢", "at-risk": "🟡", claimed: "🔵", met: "✅", missed: "❌" };
const PILLAR: Record<string, string> = { gl_fund: "Fund", gl_join: "Steer", gl_trust: "Trust" };
const LIGHT: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
const ACTION_PAST: Record<string, string> = { propose: "proposed", counter: "countered", fund: "funded", reject: "rejected", checkpoint: "held", continue: "continued", adjust: "adjusted", cut: "cut", close: "closed", edit: "edited" };
/** Collapses whitespace to one line; never cuts (no-truncation rule): the slide scrolls. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Pending assignments parked on each decision id (`waitFor {decision}`: managers' waits and parked continuations alike). */
export function decisionWaiters(world: World): Map<string, number> {
  const n = new Map<string, number>();
  for (const a of world.assignments.where("status = 'pending' AND waitFor LIKE '%\"decision\"%'")) {
    const id = a.waitFor && "decision" in a.waitFor ? a.waitFor.decision : null;
    if (id) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return n;
}

/** A meeting a human took part in (a 1:1, a town hall, or one a user spoke in), found from a mt_ id or its notes doc. */
function humanMeetingOf(world: World, id: string): Meeting | null {
  const m = id.startsWith("mt_") ? world.meetings.get(id) : world.meetings.first("notesDocId = ?", [id]);
  if (!m) return null;
  return m.withUserId || m.kind === "town-hall" || m.transcript.some((u) => u.speakerKind === "user") ? m : null;
}

function meetingLine(world: World, sourceIds: string[]): string {
  for (const id of sourceIds) {
    const m = humanMeetingOf(world, id);
    const d = m?.decisions.find((x) => !x.supersededBy);
    if (m && d) return `In ${m.withUserId ? "1:1" : m.kind === "town-hall" ? "town hall" : "meeting"} ${m.id}${m.notesDocId ? ` (notes ${m.notesDocId})` : ""}: "${oneLine(d.text)}"`;
  }
  return "";
}

/** A grant's last human entry: "Mitchell countered 2.0 d ago: "halve the ask"". */
export function grantHistoryLine(world: World, g: GrantView, now: Date): string {
  const e = [...g.history].reverse().find((h) => h.byKind === "user");
  if (!e) return "";
  return `${world.nameOf(e.byId)} ${ACTION_PAST[e.action] ?? e.action} ${waitedFor(e.at, now)} ago${e.note.trim() ? `: "${oneLine(e.note)}"` : ""}`;
}

/** The same building's previous decided rollup: its decision and note. */
export function rollupHistoryLine(world: World, doc: Doc, now: Date): string {
  if (!doc.buildingId) return "";
  const prev = world.docs.first("type = 'report' AND buildingId = ? AND decision IS NOT NULL AND decision != 'pending' AND createdAt < ? AND id != ? AND tags LIKE '%\"rollup\"%'", [doc.buildingId, doc.createdAt, doc.id], "ORDER BY createdAt DESC, rowid DESC");
  if (!prev) return "";
  const verb = prev.decisionNote ? "replied to" : prev.decision === "approve" ? "approved" : `decided (${prev.decision})`;
  return `${prev.decidedBy ? world.nameOf(prev.decidedBy) : "A human"} ${verb} the previous rollup "${oneLine(prev.title)}" ${prev.decidedAt ? `${waitedFor(prev.decidedAt, now)} ago` : ""}${prev.decisionNote ? `: "${oneLine(prev.decisionNote)}"` : ""}`.replace(/\s+$/, "");
}

const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
function mediaSrc(world: World, id: string): string | null {
  const r = world.db.prepare("SELECT mime FROM media WHERE id = ?").get(id) as { mime: string } | undefined;
  if (!r) return null;
  const ext: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" };
  return `/api/media/${id}.${ext[r.mime] ?? "png"}`;
}

/**
 * A proposal's picture: its own (propose_grant `picture`), else the first uploaded media its findings docs cite.
 * Only a picture that exists counts: a design doc's example `![alt](/api/media/mf_….png)` is not one (mt_xywhisvdcm).
 */
function proposalPicture(world: World, g: GrantView): { alt: string; src: string } | null {
  if (g.picture) { const src = mediaSrc(world, g.picture); if (src) return { alt: g.objective, src }; }
  for (const id of g.findingsDocIds) {
    for (const m of (world.docs.get(id)?.body ?? "").matchAll(new RegExp(IMAGE.source, "g"))) {
      const media = /^\/api\/media\/(mf_[a-z0-9]+)(?:\.[a-z0-9]+)?$/.exec(m[2]!);
      if (media && mediaSrc(world, media[1]!)) return { alt: m[1] || "finding", src: m[2]! };
    }
  }
  return null;
}

interface Draft { kind: ReviewSlideKind; group: number; itemId: string | null; buildingId: string | null; since: string | null; title: string; body: string; history: string; grantId?: string; docIds?: string[]; keySuffix?: string }

function card(fields: { whatItIs: string; whatYoudSee: string; picture: { alt: string; src: string } | null; pictures?: { alt: string; src: string }[]; yourCall: string }): string {
  const pics = fields.pictures ?? (fields.picture ? [fields.picture] : []);
  return [
    `**What it is:** ${fields.whatItIs || "_not given_"}`,
    `**What you'd see:** ${fields.whatYoudSee || "_not given_"}`,
    pics.length ? pics.map((p) => `![${p.alt}](${p.src})`).join("\n") : "_no picture_",
    `**Your call:** ${fields.yourCall || "_not given_"}`,
  ].join("\n\n");
}

function grantSlide(world: World, g: GrantView, now: Date): Draft {
  const b = world.buildings.get(g.buildingId)?.name ?? g.buildingId;
  // the grant's own key results (docs/how-work-gets-done.md §4): what the human funds and later marks met or missed
  const krs = g.keyResults.length ? g.keyResults : g.keyResult ? [g.keyResult] : [];
  const kr = krs.length ? `Key results: ${krs.map((k, i) => `${i + 1}) ${k.text}${k.due ? ` (due ${k.due})` : ""}${k.status !== "not-started" ? ` [${k.status}]` : ""}`).join(" · ")}` : "No key results yet";
  const testing = [...g.testingPlan.map((t) => t.howToCheck), ...krs.map((k) => k.howToCheck)].join(" · ");
  const base = { itemId: g.id, buildingId: g.buildingId, grantId: g.id, history: grantHistoryLine(world, g, now) };
  if (g.status === "checkpoint") {
    const pct = g.grantTokens ? Math.round((g.spentTokens / g.grantTokens) * 100) : 0;
    const at = [...g.history].reverse().find((h) => h.action === "checkpoint")?.at ?? g.updatedAt;
    return { ...base, kind: "checkpoint", group: 1, since: at, title: `${b}: checkpoint held — ${g.objective}`, body: card({
      whatItIs: `${g.objective} (${g.id}). ${kr}. Its grant work is stopped until you decide.`,
      whatYoudSee: testing,
      picture: proposalPicture(world, g),
      yourCall: `Spent ${fmt(g.spentTokens)} of ${fmt(g.grantTokens ?? 0)} adjusted tokens (${pct}%). Continue, adjust (top up) or cut.${g.checkpointDocId ? ` Checkpoint report ${g.checkpointDocId}.` : ""}`,
    }) };
  }
  if (g.status === "closed") {
    return { ...base, kind: "close", group: 6, since: g.closedAt ?? g.updatedAt, title: `${b}: closed as done — mark ${krs.length === 1 ? "the key result" : "its key results"}`, body: card({
      whatItIs: `${g.objective} (${g.id}). ${kr}.`,
      whatYoudSee: krs.find((k) => k.statusNote)?.statusNote || testing,
      picture: proposalPicture(world, g),
      yourCall: `Mark ${krs.length === 1 ? "the key result" : "each key result"} met or missed (spent ${fmt(g.spentTokens)} of ${fmt(g.grantTokens ?? 0)}).${g.checkpointDocId ? ` Close report ${g.checkpointDocId}.` : ""}`,
    }) };
  }
  const at = [...g.history].reverse().find((h) => h.action === "propose")?.at ?? g.updatedAt;
  return { ...base, kind: "proposal", group: 4, since: at, title: `${b}: proposal — ${g.objective}`, body: card({
    whatItIs: `${g.objective} (${g.id}). ${kr}.${g.approach ? ` ${oneLine(g.approach)}` : ""}`,
    whatYoudSee: g.whatYoudSee || testing,
    picture: proposalPicture(world, g),
    yourCall: `Fund ${fmt(g.askTokens)} adjusted tokens, counter or reject. Stops when: ${g.stopCondition}`,
  }) };
}

const GOAL_ACTION: Record<string, string> = { "add-goal": "add a goal", "add-kr": "add a key result", edit: "edit", move: "move", retire: "retire a goal", promote: "promote a key result to a goal" };

/** The words after a move or retire proposal's old text, as the goal editor's card says them (web goalTree proposalVerb). */
function goalProposalVerb(action: string, dest: string | null, hangs = false): string {
  if (action === "move") return dest ? ` moves under ${dest}` : "";
  if (action !== "retire") return "";
  return dest ? ` is retired; its open key results and attached buildings go under ${dest}` : hangs ? " is retired, but no sibling is named for what hangs under it" : " is retired; nothing open hangs under it";
}

/** A manager's goal proposal (propose_goal / propose_key_result): Accept, Edit and accept, or Cut, as in the goal editor. */
function goalProposalSlide(world: World, p: GoalProposalView): Draft {
  const tree = world.goalTree;
  const node = tree.nodeOfProposal(p);
  const kr = p.targetId ? world.keyResults.get(p.targetId) : undefined;
  const old = kr?.text ?? (p.targetId ? tree.get(p.targetId)?.text : undefined);
  const parent = p.parentId ? tree.get(p.parentId)?.text : undefined;
  const where = node ? tree.ancestors(node).reverse().map((g) => g.text).join(" › ") : "the tree";
  const b = p.buildingId ? world.buildings.get(p.buildingId)?.name ?? p.buildingId : "a human";
  // a retire names what moves, so accepting from the deck is as informed as from the editor (which also asks to confirm)
  const impact = p.action === "retire" && p.targetId && tree.get(p.targetId) ? tree.retireImpact(p.targetId) : null;
  const hangs = !!impact && impact.attached.length + impact.open.length > 0;
  const change = old && p.fields.text && p.fields.text !== old ? `"${oneLine(old)}" → "${oneLine(p.fields.text)}"`
    : old ? `"${oneLine(old)}"${goalProposalVerb(p.action, parent ? `"${oneLine(parent)}"` : null, hangs)}`
    : `"${oneLine(p.fields.text ?? "")}"${parent ? ` under "${oneLine(parent)}"` : ""}`;
  const dest = parent ? `"${oneLine(parent)}"` : "a sibling (none named: accepting is refused)";
  const moves = impact && hangs
    ? ` What moves under ${dest}: ${[...impact.attached.map((x) => `building ${x.name}`), ...impact.open.map((k) => `key result "${oneLine(k.text)}"`)].join("; ")}. A building is never archived here; it moves.`
    : "";
  const extra = [p.fields.howToCheck ? `How to check: ${oneLine(p.fields.howToCheck)}` : "", p.fields.due ? `Due ${p.fields.due}` : ""].filter(Boolean).join(" · ");
  const owner = tree.ownerOf(node ?? ROOT_GOAL_ID);
  return {
    kind: "goal-proposal", group: 4, itemId: p.id, buildingId: p.buildingId, since: p.createdAt, history: meetingLine(world, p.sourceDocIds),
    title: `${b}: goal proposal — ${GOAL_ACTION[p.action] ?? p.action}`,
    body: card({
      whatItIs: `${p.proposedByName} proposes to ${GOAL_ACTION[p.action] ?? p.action}: ${change} (${p.id}).${p.outsideScope ? " Outside its building's subtree." : ""} Why: ${oneLine(p.why) || "_not given_"}${moves}`,
      whatYoudSee: `In the Goal tree at ${where}.${extra ? ` ${extra}.` : ""}`,
      picture: null,
      yourCall: `Accept, edit and accept, or cut (a note goes back to the proposer). Routed to ${owner.userId ? world.users.get(owner.userId)?.name ?? owner.userId : "the town admins"}.`,
    }),
  };
}

/** The deck for `now`. Pure over the world: the same in-tray gives the same slides. */
export function reviewDeck(world: World, now = new Date()): ReviewDeck {
  const intray = townHallIntray(world);
  const waiters = decisionWaiters(world);
  const drafts: Draft[] = [];
  const record: Doc[] = [];

  for (const g of grantsAwaitingDecision(world)) {
    if (g.status === "countered") continue; // waiting on the manager, not a human
    drafts.push(grantSlide(world, g, now));
  }
  for (const p of intray.goalProposals) drafts.push(goalProposalSlide(world, p));
  for (const x of intray.blocked) {
    drafts.push({ kind: "blocked", group: 2, itemId: x.buildingId, buildingId: x.buildingId, since: x.since, history: "", title: `${x.name}: blocked`, body: card({
      whatItIs: `${x.name} has no key results to work toward and no funded grant, so none of its work can be funded.`,
      whatYoudSee: "The building's map sign is a red stoplight; its board shows the blocked callout.",
      picture: null,
      yourCall: "Write its key results (Building → Settings), or ask its manager to propose them in a 1:1.",
    }) });
  }
  for (const d of intray.reports) {
    const rollup = d.tags.includes("rollup");
    const parsed = rollup ? parseRollup(d.body) : null;
    const who = `${world.buildings.get(d.buildingId ?? "")?.name ?? "Town"}`;
    const history = (rollup ? rollupHistoryLine(world, d, now) : "") || meetingLine(world, d.provenance.sourceIds);
    const base = { itemId: d.id, buildingId: d.buildingId, since: d.createdAt, history, docIds: [d.id] };
    if (parsed && parsed.items.length && !parsed.missingSections.length) {
      const calls = parsed.items.map((it, i) => [it, i] as [RollupItem, number]).filter(([it]) => !isNoCall(it.yourCall));
      if (!calls.length) { record.push(d); continue; }
      for (const [it, i] of calls) {
        drafts.push({ ...base, kind: "rollup", group: 5, keySuffix: String(i + 1), title: `${who} rollup: ${it.title}`, body: `_${d.title} (${d.id}) · item ${i + 1} of ${parsed.items.length}_\n\n${card({ whatItIs: it.whatItIs, whatYoudSee: it.whatYoudSee, picture: null, pictures: it.pictures, yourCall: it.yourCall })}` });
      }
    } else {
      // an old-format rollup, a checkpoint or visitor report, an escalation: its markdown with the plain buttons
      drafts.push({ ...base, kind: "report", group: 5, title: `${who}: ${d.title}`, body: d.body.replace(/^\s*#\s+[^\n]*\n+/, "") });
    }
  }

  // what work is parked on comes right after the blocking groups, most waiters first
  const waitersOf = (d: Draft) => (d.itemId ? waiters.get(d.itemId) ?? 0 : 0) + (d.grantId ? waiters.get(world.grants.get(d.grantId)?.checkpointDocId ?? "") ?? 0 : 0);
  for (const d of drafts) if (d.group > 3 && waitersOf(d) > 0) d.group = 3;
  const t = (s: string | null) => (s ? Date.parse(s) : 0);
  const goalLast = (d: Draft) => (d.kind === "goal-proposal" ? 1 : 0);
  drafts.sort((a, b) => a.group - b.group || (a.group === 3 ? waitersOf(b) - waitersOf(a) : 0) || goalLast(a) - goalLast(b) || t(a.since) - t(b.since) || (a.keySuffix ?? "").localeCompare(b.keySuffix ?? ""));

  const slides: ReviewSlide[] = [];
  const decisions = new Set(drafts.map((d) => d.itemId)).size + record.length;
  const oldest = [...drafts.map((d) => d.since), ...record.map((d) => d.createdAt)].filter((s): s is string => !!s).sort()[0] ?? null;
  slides.push(townSlide(world, now, decisions, oldest, intray.access.length));
  for (const d of drafts) {
    const w = waitersOf(d);
    const top = [d.since ? `Waiting ${waitedFor(d.since, now)}` : "", w ? `${w} assignment${w === 1 ? "" : "s"} parked on this` : ""].filter(Boolean).join(" · ");
    const text = `${top ? `_${top}_\n\n` : ""}## ${d.title}\n\n${d.body}${d.history ? `\n\n_History: ${d.history}_` : ""}`;
    slides.push({ text, notes: "", title: d.title, pictures: [...text.matchAll(new RegExp(IMAGE.source, "g"))].map((m) => ({ alt: m[1]!, src: m[2]! })),
      key: `${d.kind}:${d.itemId}${d.keySuffix ? `:${d.keySuffix}` : ""}`, kind: d.kind, itemId: d.itemId, group: d.group, buildingId: d.buildingId,
      since: d.since, waiters: w, history: d.history, ...(d.grantId ? { grantId: d.grantId } : {}), ...(d.docIds ? { docIds: d.docIds } : {}) });
  }
  if (record.length) {
    const names = record.map((d) => `${world.buildings.get(d.buildingId ?? "")?.name ?? "?"}: ${d.title} (${d.id})`);
    const title = "For the record (no decision)";
    slides.push({ text: `## ${title}\n\nThese rollups ask nothing of you: every Shipped item's call is None.\n\n${names.map((n) => `- ${n}`).join("\n")}`, notes: "", title, pictures: [],
      key: "record", kind: "record", itemId: null, group: 7, buildingId: null, since: record[0]!.createdAt, waiters: 0, history: "", docIds: record.map((d) => d.id) });
  }
  return { title: "Review deck", generatedAt: now.toISOString(), slides };
}

function townSlide(world: World, now: Date, decisions: number, oldest: string | null, asking: number): ReviewSlide {
  const bank = world.bank.balance(now);
  const cap = world.bank.capState(now);
  const lanes = world.grantDesk.laneBudgets();
  const explSpent = lanes.reduce((s, l) => s + l.exploration.spentTodayTokens, 0);
  const free = freeTokens(world, ROOT_GOAL_ID, now).freeTokens;
  const directed = lanes.reduce((s, l) => s + l.directed.spentTodayTokens, 0);
  const rows = world.buildings.where("kind != 'town-hall'", [], "ORDER BY rowid").map((b) => {
    const light = world.grantDesk.stoplight(b);
    const krs = world.grantDesk.keyResults(b.id).filter((k) => !k.archivedAt && k.status !== "met" && k.status !== "missed");
    return `| ${b.name} | ${light ? LIGHT[light.light] ?? "" : ""} | ${krs.length ? krs.map((k) => `${KR_LIGHT[k.status] ?? "⚪"} ${k.status.replace(/-/g, " ")}`).join(" · ") : "_none_"} |`;
  });
  // desks are the steer (docs/goals.md "Effort steering is desks"): each pillar's subtree headcount (mt_n25udpflus decision 3)
  const desks = (n: GoalNode): number => n.buildings.reduce((s, b) => s + b.headcount, 0) + n.children.reduce((s, c) => s + desks(c), 0);
  const tree = world.goalTree.tree();
  const pillars = [...tree.children.map((c) => `${PILLAR[c.id] ?? c.text.split(":")[0]!.slice(0, 30)} ${desks(c)}`), ...tree.buildings.length ? [`at the root ${desks({ ...tree, children: [] })}`] : []].join(" · ");
  const flags = world.docs.where("type = 'flag' AND decision = 'pending' AND createdAt < ?", [new Date(now.getTime() - FLAG_AFTER_MS).toISOString()], "ORDER BY createdAt");
  const flagLine = flags.length
    ? `⚑ Your flag${flags.length === 1 ? "" : "s"} still waiting on a manager: ${flags.map((f) => `${world.buildings.get(f.buildingId ?? "")?.name ?? "?"} "${oneLine(f.title)}" ${waitedFor(f.createdAt, now)}`).join("; ")}.`
    : "";
  const text = [
    "# Review deck: the state of the town",
    `**Bank:** ${fmt(bank)} adjusted tokens left · subscription spend today ${fmt(cap.spentToday)}${cap.learnedCap ? ` of a ${fmt(cap.learnedCap)} daily cap` : ""}${cap.held ? " (new starts held)" : ""}`,
    `**Spend today by lane:** exploration ${fmt(explSpent)} (no allowance; ${fmt(free)} free tokens) · directed ${fmt(directed)}`,
    `**Desks by pillar:** ${pillars}`,
    `**${decisions} decision${decisions === 1 ? "" : "s"} below${oldest ? `, oldest waiting ${waitedFor(oldest, now)}` : ""}.**${asking ? ` ${asking} ${asking === 1 ? "person is" : "people are"} asking to join (in the in-tray list).` : ""}`,
    `| Building | Light | Key results |\n|---|---|---|\n${rows.join("\n")}`,
    flagLine,
  ].filter(Boolean).join("\n\n");
  return { text, notes: "", title: "State of the town", pictures: [], key: "town", kind: "town", itemId: null, group: 0, buildingId: null, since: null, waiters: 0, history: "" };
}

// ---- the deck a meeting presents: pinned while it presents (Mitchell, mt_xywhisvdcm decision 7) ----

const DOC_PAST: Record<string, string> = { approve: "approved", continue: "continued", redirect: "redirected", stop: "stopped" };

/** What became of a pinned slide's item once it left the in-tray: "cut", "funded", "approved", "met"… ("decided" when unknown). */
function decidedLabel(world: World, p: PinnedSlide): string {
  const grantId = p.grantId ?? (p.itemId?.startsWith("gr_") ? p.itemId : undefined);
  if (grantId) {
    const g = world.grants.get(grantId);
    if (g && p.kind === "close") {
      const krs = world.grantDesk.keyResultsOf(g.id);
      if (krs.length && krs.every((k) => k.status === "met" || k.status === "missed")) return krs.length === 1 ? `key result marked ${krs[0]!.status}` : `key results marked ${krs.map((k) => k.status).join(", ")}`;
    }
    const e = g ? [...g.history].reverse().find((h) => h.byKind === "user") : undefined;
    if (e) return ACTION_PAST[e.action] ?? e.action;
    if (g) return g.status;
  }
  if (p.kind === "goal-proposal" && p.itemId) {
    const gp = world.goalProposals.get(p.itemId);
    if (gp) return gp.status === "superseded" ? "superseded by a newer proposal" : gp.status;
  }
  const doc = p.docIds?.[0] ? world.docs.get(p.docIds[0]) : null;
  if (doc) return doc.decision && doc.decision !== "pending" ? DOC_PAST[doc.decision] ?? doc.decision : "archived";
  if (p.kind === "blocked") return "key results written";
  return "decided";
}

const pin = (s: ReviewSlide): PinnedSlide => ({ key: s.key, kind: s.kind, title: s.title, text: s.text, itemId: s.itemId, ...(s.grantId ? { grantId: s.grantId } : {}), ...(s.docIds ? { docIds: s.docIds } : {}) });

/**
 * The review deck as a meeting presents it: the slides in the order `pinned` froze them, each refreshed from the live
 * in-tray while its item is still there; a slide whose item was decided stays at its number, marked `decided` (no
 * buttons), and new in-tray items append at the end. `pinned` is what to store for the next call. No pin = the live deck.
 */
export function presentedReviewDeck(world: World, pinned: PinnedSlide[] | undefined, now = new Date()): ReviewDeck & { pinned: PinnedSlide[] } {
  const live = reviewDeck(world, now);
  if (!pinned?.length) return { ...live, pinned: live.slides.map(pin) };
  const byKey = new Map(live.slides.map((s) => [s.key, s]));
  const slides: ReviewSlide[] = [];
  const next: PinnedSlide[] = [];
  for (const p of pinned) {
    const s = byKey.get(p.key);
    byKey.delete(p.key);
    if (s) { slides.push(s); next.push(pin(s)); continue; }
    const decided = decidedLabel(world, p);
    slides.push({ text: `_Decided: ${decided}_\n\n${p.text}`, notes: "", title: p.title, pictures: [...p.text.matchAll(new RegExp(IMAGE.source, "g"))].map((m) => ({ alt: m[1]!, src: m[2]! })),
      key: p.key, kind: p.kind as ReviewSlideKind, itemId: p.itemId, group: 0, buildingId: null, since: null, waiters: 0, history: "", decided,
      ...(p.grantId ? { grantId: p.grantId } : {}), ...(p.docIds ? { docIds: p.docIds } : {}) });
    next.push(p);
  }
  for (const s of byKey.values()) { slides.push(s); next.push(pin(s)); }
  return { ...live, slides, pinned: next };
}
