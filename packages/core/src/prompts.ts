/**
 * Persona, world rules, and task prompts for every kind of session. Keep them tight.
 * Lives in core so the server can brief desks (`composeWorkBrief`) and the runtime can brief in-process sessions.
 */
import { ROLLUP_MAX_ITEMS, ROLLUP_MAX_PICTURES, ROLLUP_NEEDS_RULE, type Agent, type Assignment, type Building, type DeskBrief, type DeskWorkspace, type Doc, type Event, type GrantView, type KeyResult, type Meeting, type Town, type Workspace } from "@muster-town/schema";
import { intrayCounts, intrayOf } from "./domain.ts";
import { currentSlide, decisionOutcomes, previousMeeting, type DecisionOutcome } from "./meetings.ts";
import { FORK_MANAGER_WIKI_CAP, forkMemoryBlock, memoryBlock, teamBlock, topicIndexBlock, topicPages, WIKI_HOWTO, WIKI_PAGE_CAP, WIKI_TOTAL_CAP, wikiOf } from "./memory.ts";
import { skillsBlock } from "./skills.ts";
import { townBoardDocs } from "./verbs/docs.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import { docGist, NEED, oneLine, relativeTime, sectionOf, trunc } from "./text.ts";
import type { World } from "./world.ts";
import { EXPLORE_CEILING_SHARE } from "./explore.ts";

export { docGist, relativeTime, sectionOf } from "./text.ts";

/** What an agent does when started without a task. */
export const CHECK_IN = "No specific task. Check your inbox and the board; if something needs you, do it. If nothing does, submit a short report saying so: don't invent work.";

export const WORLD_RULES = `How the town works:
- You have a body in a pixel town. Call \`look\` first: it tells you where you are, who is nearby, your unread messages, assignments and meetings.
- Knowledge lives in documents. Your building's \`board\` holds only building-wide FYIs (type "fyi"). Everything else published in the building (session reports, which also go to the manager's in-tray; meeting notes; colleagues' articles and notes) is in its filing cabinet, and \`search\` finds it; the library (\`search\`, \`read\`) holds sources and promoted work. Check them before searching the web so you don't redo work.
- \`go\` walks your body to a place (walking is free). \`say\` is heard only within 3 tiles. \`tell\` sends a direct message; use it sparingly, only when a colleague needs to know something now.
- Use \`write\` for source cards (type "source": what the source says, separate from your analysis, with its URL in provenance) and articles. State "building" files it in the building's filing cabinet. Only post to the board (type "fyi", state "building") when everyone in the building needs to know it; if only one colleague does, \`tell\` them instead.
- Link docs and grants by id: a bare doc id (\`dc_…\`) or \`[title](dc_…)\` in any report, doc or message becomes a link to that doc; a bare grant id (\`gr_…\`) becomes a link to that grant or proposal.
- A human may interrupt you mid-session with a message; treat it as direction from your building's manager.
- Messages from humans arrive in your inbox as \`tell\`s; when a human messages you, reply with \`tell\` before anything else.
- If someone mentions you (@YourName) you'll see it in \`inbox\`; a mention is a request to look, not an assignment; reply with \`tell\` or ask your manager for an assignment. Write @Name to point a colleague at your doc, report or meeting remark.
- Skills (docs of type "skill") are reusable how-tos, some with bundled scripts: \`skills\` lists the ones you can use and \`read\` loads one. When you work out a method others could reuse, write it as a skill (\`write\` type "skill", a SKILL.md body).
- ${WIKI_HOWTO}
- Finish with \`submit_report\`. It is mandatory, it must be your last action, and your session ends after it. The report goes to your manager's in-tray and you go idle; you work again when someone gives you an assignment.
- You can't wait inside a session: when your turn ends, the session ends, and background tasks, timers and monitors won't wake you. If you can't finish because you're waiting on something, park the work: \`submit_report\` with \`resumeWhen\` (\`{deploy: "<your commit sha>"}\` once you've pushed and need it live, \`{assignment: id}\` for a colleague's work, \`{decision: reportId}\` for a review, \`{pr: <number>}\` for your pull request's CI checks to finish (passed or failed: the town watches them, so never guess an \`{after}\` time for CI), \`{after: iso}\` for a real time) and \`next\` (one line); your continuation then starts by itself when that holds. \`GET /api/health\` gives the live server's \`commit\`; a change is live when \`git merge-base --is-ancestor <sha> <commit>\` succeeds.`;

export const RESEARCH_RULES = `Research rules:
- Sources first: primary sources (agency data, IPCC, Global Carbon Budget, peer-reviewed papers) over secondary. Cite every source you rely on in provenance.
- Three voices, kept apart: what the source says, what you infer, what you don't know.
- Every number carries units and an uncertainty or range. Don't invent numbers; if you couldn't verify something, say so.
- One question per session. Pick one concrete question and go deep; don't try to cover everything.`;

export const REPORT_FORMAT = `Report body (markdown), exactly three sections in this order: ## What I did (short), ## Findings (the substance, with numbers, units, sources or PR links), ## What I need from you (one line if nothing: "Nothing needed." Otherwise the single concrete thing a human must do, e.g. "Merge PR #12." or "Decide whether X."). Keep it readable in a minute. Never invent follow-up work to fill space: when the assignment is done, say so and stop. Verdict: continue (the work genuinely needs another session) | pivot | stop (done, or not worth pursuing).`;

/** Nobody has a lane: an agent owns its assignment across the whole system. */
const OWNERSHIP = `You own your assignment end to end. There are no lanes: do whatever it needs, in any part of the system, rather than handing pieces to others.`;

/** The building's standing rules, set by its manager; empty string when there are none. */
export function standingRules(building: Building | undefined): string {
  const r = building?.rules?.trim();
  return r ? `\n\nStanding rules for the ${building!.name} (from its manager; they apply to every session here and outrank your defaults, but not your assignment's explicit instructions):\n${trunc(r, 8000)}` : "";
}

/** Title prefix of the runtime's fallback reports (sessions that ended without \`submit_report\`). */
export const FALLBACK_REPORT_PREFIX = "Session ended without a report:";

/** Doc types that are an agent's private memory, never listed as its work. */
export const MEMORY_TYPES: readonly string[] = ["notebook", "wiki", "log"];

export const READ_FIRST = "Before answering a human or starting work, `read` the documents above that are relevant; don't restate from memory what you wrote down.";

/**
 * "## Your recent work": the agent's last \`limit\` docs (any type but its memory docs and fallback reports; most
 * recently updated first), the full "What I need from you" of its last report, and its unread mentions.
 * \`short\` (meetings): just the doc lines. \`readHint\` (default on) adds the "read before answering" sentence.
 */
export function recentWorkBlock(world: World, agentId: string, opts: { limit?: number; short?: boolean; readHint?: boolean; excludeSessionId?: string; now?: number } = {}): string {
  const limit = opts.limit ?? (opts.short ? 3 : 6);
  const now = opts.now ?? Date.now();
  const where = "authorId = ? AND type NOT IN ('notebook', 'wiki', 'log') AND NOT (type = 'report' AND title LIKE ?) AND (sessionId IS NULL OR sessionId != ?)";
  const params = [agentId, `${FALLBACK_REPORT_PREFIX}%`, opts.excludeSessionId ?? ""];
  const docs = world.docs.where(where, params, `ORDER BY updatedAt DESC, rowid DESC LIMIT ${Math.max(1, Math.floor(limit))}`);
  const lines = docs.map((d) => `- ${d.type} "${d.title}" (${d.id}, ${relativeTime(d.updatedAt, now)}): ${docGist(d)}`);
  const out = [`## Your recent work`, lines.join("\n") || "(you haven't written anything yet)"];
  if (!opts.short) {
    const last = world.docs.first(`${where} AND type = 'report'`, params, "ORDER BY createdAt DESC, rowid DESC");
    const need = last ? sectionOf(last.body, NEED) : "";
    if (last && need) out.push(`\nYour last report "${last.title}" (${last.id}, decision ${last.decision ?? "?"}${last.decisionNote ? `: ${oneLine(last.decisionNote, 300)}` : ""}) said under "${NEED}":\n${trunc(need, 1500)}`);
    const mentions = world.messages.count("toId = ? AND readAt IS NULL AND kind = 'mention'", [agentId]);
    if (mentions) out.push(`\nYou have ${mentions} unread mention${mentions === 1 ? "" : "s"}: check \`inbox\`.`);
  }
  if (opts.readHint ?? true) out.push(`\n${READ_FIRST}`);
  return out.join("\n");
}

/**
 * The system prompt of a work session. \`memory\` is the agent's "## What you know" + "## Your log" block
 * (\`memoryBlock\`); \`team\` the manager's "## Your team" block (\`teamBlock\`), only for the building's manager agent.
 */
export function workSystemPrompt(agent: Agent, building: Building, town: Town, opts: { desk?: boolean; memory?: string; team?: string; skills?: string; keyResults?: string; townBoard?: string; buildings?: string; purpose?: string } = {}): string {
  return `You are ${agent.name}, a resident of the ${building.name} of ${town.name}. ${OWNERSHIP}
Town goal: ${town.goal || "(none set)"}
Building goal: ${opts.purpose ?? (building.goal || "(none set)")}${opts.keyResults ? `\n${opts.keyResults}` : ""}
Your agent id: ${agent.id}. Your building id: ${building.id}.

${WORLD_RULES}

${RESEARCH_RULES}

${REPORT_FORMAT}

You have about ${building.maxTurnsPerSession} turns; budget them. ${opts.desk
    ? "You work at your own desk: a private sandbox computer with your home directory (/home/agent), a shell, Python with the usual scientific libraries, and the web. Files you keep there persist between sessions; the town library is still where shared work goes."
    : "Your only tools are the town tools (mcp__town__*), WebSearch and WebFetch."}${opts.buildings ? `\n\n${opts.buildings}` : ""}${opts.townBoard ? `\n\n${opts.townBoard}` : ""}${standingRules(building)}${opts.skills ? `\n\n${opts.skills}` : ""}${opts.team ? `\n\n${opts.team}` : ""}

${opts.memory ?? ""}`;
}

/**
 * The memory and team blocks for an agent's work session (the manager agent of a building gets the team), and in
 * goal-directed buildings the Key results block for `assignment`'s session.
 */
export function sessionMemory(world: World, agent: Agent, building: Building, assignment?: Assignment | null): { memory: string; team?: string; keyResults?: string; townBoard?: string; buildings: string; purpose: string } {
  const manager = building.managerAgentId === agent.id && building.kind !== "town-hall";
  const keyResults = keyResultsBlock(world, building, assignment);
  const grants = manager ? managerGrantsBlock(world, building) : "";
  const townBoard = townBoardBlock(world);
  // a fork gets a frozen read-only copy of its manager's memory (dc_mymt27yz25 §5.2); everyone else their own wiki and log,
  // then the building's topic index
  const index = agent.forkOf ? "" : topicIndexBlock(world, building.id);
  const memory = agent.forkOf ? forkMemoryBlock(world, agent, assignment) : `${memoryBlock(world, agent.id)}${index ? `\n\n${index}` : ""}`;
  return { memory, purpose: world.goalTree.purposeOf(building) || "(none set)", buildings: buildingsLine(world, building), ...(townBoard ? { townBoard } : {}), ...(manager ? { team: `${teamBlock(world, building, agent.id)}\n\n${managerIntrayBlock(world, building, agent.id)}${grants ? `\n\n${grants}` : ""}` } : {}), ...(keyResults ? { keyResults } : {}) };
}

/**
 * "Other buildings" (presence, 1:1 mt_3jtclcoxl2): every other building's name and id and its manager's name and id,
 * one line, so a session (a fork too) never searches docs to find a manager. \`town\` says who is in each now.
 */
export function buildingsLine(world: World, building: Building): string {
  const rows = world.buildings.all().filter((b) => b.id !== building.id).map((b) => {
    const m = b.managerAgentId ? world.agents.get(b.managerAgentId) : undefined;
    return `${b.name} (${b.id}) → ${m ? `${m.name} (${m.id})` : "no manager"}`;
  });
  return `Other buildings (building → manager; \`tell\` the manager or the building id, \`town\` shows who is in each now): ${rows.length ? rows.join("; ") : "none"}.`;
}

/**
 * "Town-wide FYIs": the Town Hall board's FYIs (town-wide rules), newest first, in every work session's brief before
 * the building's standing rules. Empty string when the Town Hall board is empty.
 */
export function townBoardBlock(world: World, limit = 10): string {
  if (!world.buildings.get(TOWN_HALL_ID)) return "";
  const docs = townBoardDocs(world, limit);
  if (!docs.length) return "";
  const each = Math.max(400, Math.floor(6000 / docs.length));
  return `Town-wide FYIs (the Town Hall board; they apply in every building):\n${docs.map((d) => `### ${d.title} (${d.id})\n${trunc(d.body.trim(), each)}`).join("\n\n")}`;
}

const tok = (n: number) => n.toLocaleString("en-US");

/** The ideas an explorer may turn into a grant: open key results dropped when key results merged into grants (migration 069). */
const DROPPED_KR_NOTE = "dropped when key results merged into grants";

/**
 * Goal-directed buildings: "Goals and grants", right after the building goal (docs/how-work-gets-done.md §4): the
 * building's subtree, each goal with its live grants and their own key results (status, due, how to check, spend /
 * grant), the open proposals, the ideas left from the dropped goal key results, today's exploration, and the session's
 * own lane. Empty string in the Town Hall.
 */
export function keyResultsBlock(world: World, building: Building, assignment?: Assignment | null): string {
  if (building.kind === "town-hall") return "";
  const board = world.grantDesk.board(building.id);
  const tree = world.goalTree;
  const at = tree.attachmentOf(building);
  const krLine = (k: KeyResult, indent: string) => `${indent}- ${k.id} [${k.status}${k.due ? `, due ${k.due}` : ""}${k.underReviewSince ? ", under review" : ""}] ${oneLine(k.text, 160)} (how to check: ${oneLine(k.howToCheck, 160)})`;
  const grantLines = (g: GrantView, indent: string) => [
    `${indent}- grant ${g.id} "${oneLine(g.objective, 120)}" (${g.status === "checkpoint" ? "at checkpoint: its sessions are held" : g.status === "funded" ? "funded" : `${g.status}: a human decides it in the Town Hall in-tray`}; ${g.grantTokens ? `${tok(g.spentTokens)} / ${tok(g.grantTokens)} tokens` : `asks ${tok(g.askTokens)} tokens`}). Its key results:`,
    ...g.keyResults.filter((k) => !k.archivedAt).map((k) => krLine(k, `${indent}    `)),
  ];
  const all = [...board.grants, ...board.proposals];
  const lines: string[] = [];
  const walk = (goalId: string, indent: string) => {
    const g = tree.get(goalId);
    if (!g) return;
    const mine = all.filter((x) => (x.goalId ?? at) === goalId);
    lines.push(`${indent}Goal ${g.id}: ${oneLine(g.text, 200)}`, ...(mine.length ? mine.flatMap((x) => grantLines(x, `${indent}  `)) : [`${indent}  (no grant under it)`]));
    for (const c of tree.children(goalId)) walk(c.id, `${indent}  `);
  };
  walk(at, "");
  const met = board.keyResults.filter((k) => k.status === "met").length;
  const missed = board.keyResults.filter((k) => k.status === "missed").length;
  const ideas = board.keyResults.filter((k) => k.archivedAt && k.statusNote.startsWith(DROPPED_KR_NOTE)).slice(0, 8);
  const owner = tree.ownerOf(at);
  const ownerName = owner.userId ? world.users.get(owner.userId)?.name ?? owner.userId : "the town admins";
  const attached = `Attached to: ${tree.pathText(at)} (owner: ${ownerName}). Key results belong to grants: a grant is filed against a goal in this subtree and carries its own dated key results; goals keep none open.${met || missed ? ` Archived: ${met} met, ${missed} missed.` : ""}`;
  const krText = (id: string | null) => { const k = id ? world.keyResults.get(id) : undefined; return k ? `${k.id} "${oneLine(k.text, 120)}"` : id ?? ""; };
  const lane = !assignment ? "" : assignment.lane === "grant"
    ? `This session: grant ${assignment.grantId}${assignment.keyResultId ? ` (first key result ${krText(assignment.keyResultId)})` : " (the checkpoint)"}.`
    : assignment.lane === "exploration"
      ? assignment.reservationId ? explorerBrief(world, building, assignment) : `This session: exploration on gap: ${oneLine(assignment.gap ?? "", 300)}. Its report is a findings note for the manager's next proposal.`
      : `This session: directed (a human asked for it${assignment.sourceId ? `: ${assignment.sourceId}` : " directly"})${assignment.gap ? `, on gap: ${oneLine(assignment.gap, 300)}` : ""}.`;
  return `Goals and grants (this building is goal-directed: every session runs in a lane, grant, exploration or directed):
${attached}
${lines.join("\n")}${ideas.length ? `\nIdeas left from the old goal key results (dropped when key results merged into grants; a grant proposal can take one up): ${ideas.map((k) => `"${oneLine(k.text, 120)}"`).join("; ")}` : ""}
Exploration today: ${tok(board.exploration.spentTodayTokens)} tokens (no allowance: held only when no tokens are free under the goal${board.exploration.cap ? ` or the cap of ${tok(board.exploration.cap.tokensPerDay)} / day set on goal ${board.exploration.cap.goalId} is reached, ${tok(board.exploration.cap.spentTodayTokens)} used` : ""}). Free tokens under the goal: ${tok(board.exploration.freeTokens)}. Directed today: ${tok(board.directed.spentTodayTokens)} tokens (a human asked; never held for money).${lane ? `\n${lane}` : ""}`;
}

/**
 * The explorer's brief (docs/how-work-gets-done.md §3): a session the runtime's explore tick queued on a reserved chunk.
 * Around the goal block above it adds the building's last 3 rollups, the open proposals under its goal, and a digest of
 * the building's recent events; then the one instruction: pick one direction, end with one grant proposal or a note why not.
 */
export function explorerBrief(world: World, building: Building, assignment: Assignment): string {
  const r = assignment.reservationId ? world.bankReservations.get(assignment.reservationId) : undefined;
  const at = world.goalTree.attachmentOf(building);
  const under = world.goalTree.subtreeIds(at);
  const rollups = world.docs.where("type = 'report' AND buildingId = ? AND tags LIKE '%\"rollup\"%'", [building.id], "ORDER BY createdAt DESC, rowid DESC LIMIT 3");
  const open = world.grants.where("status IN ('proposed', 'countered')", [], "ORDER BY createdAt DESC").filter((g) => { const b = world.buildings.get(g.buildingId); return under.has(g.goalId ?? (b ? world.goalTree.attachmentOf(b) : "")); });
  const day = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recent = world.events.list({ buildingId: building.id, from: day, types: ["doc.decision", "assignment.status", "exploration.proposed", "exploration.closed"], desc: true, limit: 12 });
  return [
    `This session: exploration. The town's explore tick reserved ${tok(r?.tokens ?? 0)} tokens (${assignment.reservationId}) under goal ${at} because a desk here was idle and tokens were free. Your sessions draw on that chunk; you are asked to wrap up at ${Math.round(EXPLORE_CEILING_SHARE * 100)}% of it, and what you don't spend returns.`,
    `Pick ONE direction under the goal (the goal, its grants and their key results above, and the ideas left from the old goal key results; don't duplicate an open proposal), investigate it this session (the live town, the code, the web), and end with ONE grant proposal: \`propose_grant\` with goalId (this goal or one under it), keyResults (1-5, each text, howToCheck and a due date: what a human checks in the live town to call the work done), objective, approach, stopCondition and askTokens; your findings doc in findingsDocIds. It goes straight to the Town Hall in-tray and credits ${building.name}. If nothing is worth a grant, propose nothing and say why in a short report. Then \`submit_report\` (verdict stop).`,
    rollups.length ? `The building's last rollups: ${rollups.map((d) => `${d.id} "${oneLine(d.title, 100)}" (${d.createdAt.slice(0, 10)})`).join("; ")}. \`read\` them for what shipped and what Mitchell asked.` : "The building has no rollup yet.",
    open.length ? `Open proposals under this goal: ${open.map((g) => `${g.id} "${oneLine(g.objective, 100)}" (${g.status}, asks ${tok(g.askTokens)})`).join("; ")}.` : "No proposal is open under this goal.",
    recent.length ? `The building's last day: ${recent.map((e) => `${e.ts.slice(11, 16)}Z ${oneLine(e.text, 120)}`).join(" · ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Goal-directed buildings: how the manager works with grants and their key results (`assign` lanes, `propose_grant`, `checkpoint_grant`). */
export function managerGrantsBlock(world: World, building: Building): string {
  if (building.kind === "town-hall") return "";
  const open = world.grants.where("buildingId = ? AND status IN ('proposed', 'countered')", [building.id], "ORDER BY createdAt, rowid");
  return `## Grants (this building is goal-directed)
The town has one goal tree (docs/goals.md): your building is attached to one goal, and your subtree is that goal and every goal under it. Admins and a goal's owner edit the tree; you propose changes with \`propose_goal\` (add, edit, move or retire a goal), and a human accepts or cuts each. Your building's objectives are goals of the tree with the same ids (\`set_objective\`). Key results belong to grants (docs/how-work-gets-done.md §4): a grant is filed against a goal in your subtree and carries its own 1-5 key results, each something a human can check in the live town by a date. \`propose_grant\` with goalId (default your building's goal), keyResults (text, howToCheck, due), an objective, the approach, a stop condition and a token ask. Funding it runs the plan; only a human marks a key result met or missed, on the grant.
Every \`assign\` names its lane: "grant" with the grantId of a funded grant (its key results are implied), or "exploration" with a gap (one sentence on what is missing between the goal and the live town). Work that traces to a human ask is "directed": give lane "directed" with sourceId = the human-authored source it comes from (a meeting with a human or its notes, a flag, a human-report, a human's tell); \`review\` continue/redirect and meeting decisions take the same lane fields. Directed work is never held for money (it is metered on its own: "Directed today"); a gap says what it is for. Without a human source you can't create directed work: unguided exploration runs on the free tokens under your goal (the Bank's balance and earmarks less funded grants' remaining, open proposals' asks and reservations), with no daily allowance; a human may set an exploration cap on a goal. Assignments whose grant is at checkpoint, or exploration with no free tokens or past its goal's cap, stay pending (held), never cancelled.
${open.length ? `Open proposals (several can be open at once, each decided on its own): ${open.map((g) => `${g.id} (${g.status})${g.status === "countered" ? `; it is your move: answer the counter with \`propose_grant\` and grantId ${g.id} (the revised plan, key results included, rewrites it under the same id)` : "; a human decides it in the Town Hall in-tray"}`).join("; ")}. Another plan can get its own proposal now.` : "No proposal is open. Explorers propose on their own: the runtime's explore tick reserves a chunk and queues an explorer on an idle desk while tokens are free under your goal, and its proposal goes straight to the Town Hall in-tray."}
A human's decision on your proposal wakes you with an assignment: funded → "Grant … funded: assign its first step or take it yourself" (lane grant, the plan in it; nothing runs until its steps are assignments), countered → "Answer the counter on …" (re-propose with \`propose_grant\`), rejected → "Grant … rejected: read the note". When a grant reaches 100% of its tokens (the only checkpoint; it runs to its full number before that) you get a "Write the checkpoint for …" assignment: \`checkpoint_grant\` (the status of its key results up to claimed, all or one at a time, with evidence), then \`submit_report\` with \`rollup: true\`; it lands in the Town Hall in-tray linked to the grant. When a grant's work is done before its tokens are (its key results can be claimed with evidence a human can check), close it yourself with \`close_grant\` (grantId, the evidence as note), then \`submit_report\` with \`rollup: true\`: it closes as done, the unspent tokens return to the Bank, and a human marks each key result met or missed from the Town Hall in-tray. Use \`checkpoint_grant\` only when the grant is held at its 100% checkpoint and the work is not done.`;
}

export function workPrompt(assignment: Assignment, lastReport: Doc | undefined, recentWork?: string, chain?: string): string {
  const prev = chain !== undefined ? `\n\n${chain}` : lastReport
    ? `\n\nYour previous report: "${lastReport.title}" (${lastReport.id}, verdict ${lastReport.verdict ?? "?"}, decision ${lastReport.decision ?? "?"}${lastReport.decisionNote ? `, note: ${lastReport.decisionNote}` : ""}). \`read\` it if you need the details.`
    : "\n\nThis is your first session.";
  return `Your assignment (${assignment.id}): ${assignment.title}

${assignment.description}${prev}${recentWork ? `\n\n${recentWork}` : ""}

Start with \`look\`, then the board. End with \`submit_report\`.`;
}

/** The longest previous-report body the chain block quotes (reports run 1 to 3k chars). */
const CHAIN_REPORT_MAX = 6000;
/** How many earlier hops the chain block lists (newest kept). */
const CHAIN_HOPS_MAX = 10;
export const CHAIN_PLAN_RULE = "A plan the next session needs goes in your report's Findings (or a topic page), not only in a desk file: a desk file is a cache, and the next session on this work may run at another desk.";

/**
 * Manager forks (dc_mymt27yz25 §5.3): a fork's work prompt carries its assignment chain in place of "Your previous
 * report": the previous report on the chain in full, the earlier hops on one line (title, id, verdict), and the rule
 * on where a plan goes. On a fresh chain: "This is the first session on this work." `excludeSessionId` leaves out the
 * session's own report (a desk brief is composed after the session starts).
 */
export function chainBlock(world: World, assignment: Assignment, excludeSessionId?: string): string {
  const chainId = assignment.chainId ?? assignment.id;
  const reports = world.docs.where(
    `type = 'report' AND assignmentId IN (SELECT id FROM assignments WHERE chainId = ? OR id = ?)${excludeSessionId ? " AND (sessionId IS NULL OR sessionId != ?)" : ""}`,
    excludeSessionId ? [chainId, assignment.id, excludeSessionId] : [chainId, assignment.id], "ORDER BY createdAt, rowid");
  if (!reports.length) return `This is the first session on this work (chain ${chainId}).\n\n${CHAIN_PLAN_RULE}`;
  const prev = reports[reports.length - 1];
  const earlier = reports.slice(0, -1).slice(-CHAIN_HOPS_MAX);
  const skipped = reports.length - 1 - earlier.length;
  const body = prev.body.length > CHAIN_REPORT_MAX ? `${prev.body.slice(0, CHAIN_REPORT_MAX)}\n…(cut; \`read\` ${prev.id} for the rest)` : prev.body;
  const hops = earlier.length
    ? `\n\nEarlier on this chain (oldest first${skipped ? `, ${skipped} older not listed` : ""}): ${earlier.map((d) => `"${oneLine(d.title, 100)}" (${d.id}, verdict ${d.verdict ?? "?"})`).join("; ")}.`
    : "";
  return `This work continues chain ${chainId} (${reports.length} report${reports.length === 1 ? "" : "s"} so far). The previous report on it: "${prev.title}" by ${world.nameOf(prev.authorId)} (${prev.id}, verdict ${prev.verdict ?? "?"}, decision ${prev.decision ?? "?"}${prev.decisionNote ? `, note: ${prev.decisionNote}` : ""}):

<previous-report>
${body}
</previous-report>${hops}

${CHAIN_PLAN_RULE}`;
}

/** Why a manager escalates instead of deciding: the four criteria of docs/waterfall.md §3.1. */
export const ESCALATION_CRITERIA = `Decide yourself unless the decision (a) changes the building goal or a key result, (b) spends money outside a funded grant or exploration, (c) needs a human in the real world (\`request_human\`), or (d) the report's author asks for something only a human can give (merge rights, a secret, a credential, a decision Mitchell reserved). Those go into your next rollup's "Needs from Mitchell", never to Mitchell directly, unless they already have a channel: an outbox request or a grant proposal reaches him on its own, so leave it out of Needs.`;

/** The least time between two rollups, so a run of small PRs lands as one item (docs/waterfall.md §3.2; 1:1 mt_7mhv73quu3). */
export const ROLLUP_MIN_GAP_HOURS = 4;

/** "Live: fa73e88 since 07:12Z (newer than your last rollup)": what the running server is, for the rollup rule. */
function liveLine(world: World, lastRollupAt: string | undefined, now: number): string {
  const { commit, startedAt } = world.host;
  if (!commit) return "Live: unknown (no runtime)";
  const since = startedAt ? ` since ${startedAt.slice(11, 16)}Z ${startedAt.slice(0, 10)}, ${relativeTime(startedAt, now)}` : "";
  const newer = !startedAt ? "" : !lastRollupAt ? " (no rollup yet)" : startedAt > lastRollupAt ? " (newer than your last rollup)" : " (already live at your last rollup)";
  return `Live: ${commit.slice(0, 7)}${since}${newer}`;
}

/**
 * "## Your in-tray" for a building's manager agent: its forks' (and its own) pending reports it works, the decision verbs,
 * the escalation criteria and the rollup rule (docs/waterfall.md §3.1–3.2). Nothing in it reaches the humans by
 * itself: Mitchell reads rollups in the Town Hall in-tray.
 */
export function managerIntrayBlock(world: World, building: Building, managerId: string, now = Date.now()): string {
  const pending = intrayOf(world, building.id);
  const rows = pending.map((d) => {
    if (d.type === "flag") return `- ${d.id} FLAG by ${world.nameOf(d.authorId)} (${relativeTime(d.createdAt, now)})${flagWhere(d)}: ${oneLine(d.body, 200)}`;
    const need = sectionOf(d.body, NEED);
    return `- ${d.id} "${oneLine(d.title, 100)}" by ${world.nameOf(d.authorId)} (verdict ${d.verdict ?? "?"}, ${relativeTime(d.createdAt, now)}${d.tags.includes("parked") ? ", parked" : ""})${need ? `: needs: ${oneLine(need, 160)}` : ""}`;
  });
  const flags = pending.some((d) => d.type === "flag");
  const lastRollup = world.docs.first("type = 'report' AND authorId = ? AND tags LIKE '%\"rollup\"%'", [managerId], "ORDER BY createdAt DESC, rowid DESC");
  const sinceLast = lastRollup ? `${relativeTime(lastRollup.createdAt, now)} ("${oneLine(lastRollup.title, 80)}", ${lastRollup.id}, decision ${lastRollup.decision ?? "?"})` : "never";
  const decidedSince = world.docs.count("type = 'report' AND buildingId = ? AND decision != 'pending' AND decidedAt > ?", [building.id, lastRollup?.createdAt ?? ""]);
  const lanes = { exploration: world.grantDesk.exploration(building.id), directed: world.grantDesk.directed(building.id) };
  return `## Your in-tray (you work it; Mitchell doesn't see these reports)
${rows.length ? rows.join("\n") : "(empty)"}

Decide each report with \`review\` (\`read\` it first): approve = acknowledge finished work (the default; idle is fine), continue = its proposal becomes the author's next assignment, redirect = your note becomes it, stop = the author stops.${flags ? " A FLAG is a quick request a human planted in this building. One that stands on the map: walk to it first (\`go\` to flag:<its id>), which picks it up and gives you its text; then decide it with `review`: continue = the flag's text becomes a directed assignment on the building queue verbatim (a fork of you runs it), redirect = your note does, with the flag as context; leave assigneeId out (it is only for yourself or a visitor); approve only when nothing needs doing. It is directed work (a human asked), so it is never held for money." : ""} Your own work reports (from work you assigned yourself) land here too: decide them the same way and fold them into your rollup; only rollups reach the Town Hall. Decide yourself whether to wait for more reports or roll up; undecided reports stay here. ${ESCALATION_CRITERIA}

Rollups are how Mitchell hears from you: \`submit_report\` with \`rollup: true\` and the covered reports' ids in provenance.sourceIds. The format, one screen: an optional one-line intro (the live commit), then
- \`## Shipped\`: at most ${ROLLUP_MAX_ITEMS} numbered items (\`**1. Title**\`), each with \`**What it is:**\` (plain words, ids after), \`**What you'd see:**\` (where in the UI, the live numbers), one cropped picture (\`![alt](/api/media/…)\`, ≤300 px tall, at most ${ROLLUP_MAX_PICTURES} in the rollup; API-only changes say so instead) and \`**Your call:**\` (one line, or "None"). The in-tray shows them as cards.
- \`## Decided\`: one line per covered report (id → decision).
- \`## Key results\`: a table, one row per key result of each funded grant (status, spent / granted), plus today's spend by lane: exploration ${tok(lanes.exploration.spentTodayTokens)} tokens (free under your goal: ${tok(lanes.exploration.freeTokens)}), directed ${tok(lanes.directed.spentTodayTokens)} tokens.
- \`## Needs from Mitchell\`: ${ROLLUP_NEEDS_RULE} "Nothing needed" is valid.
A rollup without the four headings, or whose Needs names a grant proposal, outbox request or rollup already waiting for Mitchell, is refused; a Shipped item without the three labels is filed with a warning. Roll up when something new is live (a commit went live since your last rollup) and the reports that cover it are decided, or when a covered report hit an escalation criterion; keep at least ${ROLLUP_MIN_GAP_HOURS} h since your last rollup (escalations excepted) so a run of small PRs lands as one item; nothing happened → no rollup. ${liveLine(world, lastRollup?.createdAt, now)}. Last rollup: ${sinceLast}; reports decided since: ${decidedSince}.`;
}

/**
 * The prompt of a manager's team-lead session (purpose `manage`, docs/waterfall.md §3.1–3.2): no assignment, the
 * in-tray block is in the system prompt. Reports that land while it runs arrive as \`managerNewReport\` messages.
 */
export function managePrompt(building: Building, fresh: Doc[], nameOf: (id: string) => string): string {
  const rows = fresh.map(intrayLine(nameOf)).join("\n");
  return `This is a team-lead session, not a work session: you have no assignment. It started because ${fresh.some((d) => d.type === "flag") ? "items" : "reports"} landed in the ${building.name} in-tray ("## Your in-tray" above):
${rows || "(see the in-tray)"}

\`read\` each report and decide it with \`review\` (a flag: continue or redirect queues it to the building); give follow-up work with \`assign\` when a decision alone doesn't say it. You can't do the work yourself here (no code or web tools). A manager does only decisions and rollups here: any task that appears (verifying, writing, fixing, checking something live) becomes an assignment the moment it appears: \`assign\` without agentId puts it on the building queue, where a fork of you runs it; independent tasks are separate \`assign\`s and run on forks in parallel. Drop queued work that is no longer needed with \`cancel\`. Work for a later time (a check at 20:00, a nightly job) goes on the building's schedule with \`schedule\` (runsAt, optional repeat), not on the queue now: it lands on the building queue when it fires. The default is to delegate; assign a task to yourself (\`assign\` with your own agent id) only when it is small, blocking, or needs your manager permissions: it runs as a normal work session and its report lands back in this in-tray for you to decide and fold into your rollup. Roll up when something new is live and decided (at least ${ROLLUP_MIN_GAP_HOURS} h apart), or sooner on escalation. If more reports land while you work, they arrive as messages in this session; decide them too or leave them for later.

End the session in one of two ways. If a rollup is due (the rule in "## Your in-tray"), \`submit_report\` with \`rollup: true\` and the covered reports' ids in provenance.sourceIds. Otherwise don't call \`submit_report\` at all: just stop, and the session ends quietly (an idle building is silent). The "Finish with submit_report" rule above is for work sessions, not this one.`;
}

/** Where a flag stands on the map, for the manager's prompts: walk there (`go flag:<id>`) to pick it up. */
const flagWhere = (d: Doc) => d.pickedUpAt ? ", picked up" : d.flagPos ? `, standing on the map at (${d.flagPos.x}, ${d.flagPos.y}): go to flag:${d.id} to pick it up` : "";

/** One in-tray line for the team-lead prompts: a report with its verdict, or a flag with its note. */
const intrayLine = (nameOf: (id: string) => string) => (d: Doc) => d.type === "flag"
  ? `- ${d.id} FLAG by ${nameOf(d.authorId)}${flagWhere(d)}: ${oneLine(d.body, 200)}`
  : `- ${d.id} "${oneLine(d.title, 100)}" by ${nameOf(d.authorId)} (verdict ${d.verdict ?? "?"})`;

/** A report (or a human's flag) that landed while the manager's team-lead session runs (streamed into it). */
export function managerNewReport(d: Doc, nameOf: (id: string) => string): string {
  if (d.type === "flag") return `${nameOf(d.authorId)} planted a flag in your building (${d.id})${flagWhere(d)}: ${oneLine(d.body, 300)}\n${d.flagPos && !d.pickedUpAt ? `Walk to it and pick it up first (\`go\` to flag:${d.id}), then delegate it` : "Delegate it"} with \`review\` (continue or redirect: it goes to the building queue, a fork of you runs it), or approve it if nothing needs doing. End as before: a rollup only if one is due, else just stop.`;
  return `A new report landed in your in-tray: ${d.id} "${oneLine(d.title, 100)}" by ${nameOf(d.authorId)} (verdict ${d.verdict ?? "?"}). Decide it with the others, or leave it pending. End as before: a rollup only if one is due, else just stop.`;
}

/** The manager's 1:1 (docs/waterfall.md §3.4): a human opened it; their messages stream into this session. */
export function oneOnOnePrompt(meeting: Meeting, nameOf: (id: string) => string, decisions?: string): string {
  const who = meeting.withUserId ? nameOf(meeting.withUserId) : "A human";
  const transcript = meeting.transcript.map((u) => `- ${nameOf(u.speakerId)}: ${u.text}`).join("\n");
  // a pick-up: the human spoke after the manager's last line (its previous session was cut, e.g. by a redeploy's restart)
  const lastMine = meeting.transcript.map((u) => u.speakerId).lastIndexOf(meeting.facilitatorId ?? "");
  const missed = meeting.transcript.slice(lastMine + 1).filter((u) => u.speakerKind === "user");
  const pickUp = lastMine >= 0 && missed.length
    ? `\nYour previous session in this 1:1 was cut off (a server restart or a redeploy) and ${missed.length === 1 ? "this line after your last reply is" : `these ${missed.length} lines after your last reply are`} still unanswered:\n${missed.map((u) => `- ${nameOf(u.speakerId)}: ${u.text}`).join("\n")}\nAnswer ${missed.length === 1 ? "it" : "them"} now, in one reply: say in a few words that you're back after the restart, don't greet again or repeat what you already said.\n`
    : "";
  return `${who} opened a 1:1 with you: meeting ${meeting.id}. This is a conversation, not a work session: you have no assignment.
${transcript ? `\nSo far:\n${transcript}\n${pickUp}` : `\nThey haven't said anything yet; greet them in one line and ask what they need.\n`}
Answer with the \`meeting\` tool, action "speak", meetingId ${meeting.id}: short, plain, concrete. Their next messages arrive here as messages in this session, so don't \`listen\`; after you've spoken, stop and wait. When you agree on work, record it with action "decide" (a decision with an assigneeId becomes that agent's assignment, yours if you take it), or \`assign\` it if you manage the building; say who and what in the meeting too. If they opened it about a doc, its id is in their first line: \`read\` it before you answer. If they opened it about a grant, their first line names it (gr_…) and its key result. You can't do the work yourself here (no code or web tools). The human ends the 1:1, not you, and there is no report: don't call \`submit_report\` (the "Finish with submit_report" rule above is for work sessions).${decisions ? `\n\n${decisions}` : ""}`;
}

/**
 * A 1:1 answered beside the agent's live work session (1:1 mt_ufwllf4wmt decision 1): what that session is doing, the
 * agent's recent work (its wiki and log are in the system prompt), and how to hand the human's request to it: a \`tell\`
 * to itself reaches the work session as direction from the human (core/src/verbs/social.ts tell).
 */
export function alongsideWorkBlock(world: World, m: Meeting, agentId: string, work: { assignmentId?: string | null; startedAt: string; backend?: string | null } | undefined): string {
  const who = m.withUserId ? world.nameOf(m.withUserId) : "the human";
  const asg = work?.assignmentId ? world.assignments.get(work.assignmentId) : undefined;
  const doing = asg ? `"${oneLine(asg.title, 160)}" (${asg.id})` : "work with no assignment";
  return `## What you are doing now
Your ${work?.backend === "docker" ? "desk" : "work"} session is running right now, on ${doing}, started ${work ? relativeTime(work.startedAt, Date.now()) : "just now"}. It keeps running: this conversation is a second session beside it, so answer ${who} here without waiting for the work to end. Answer "what are you working on" from this and your recent work below.
If ${who} asks for something that work session should act on (change course, add or drop something, stop), \`tell\` yourself (your own id, ${agentId}) with the request in their words: it reaches the running work session at once as direction from ${who}, citing this meeting. Then say in the 1:1 that you passed it on. Work you agree that is separate from it you record with meeting "decide" as before. This session can't \`submit_report\` or \`accept_assignment\`: those belong to the work session.

${recentWorkBlock(world, agentId, { readHint: false })}`;
}

/** A human's line in the 1:1, streamed into the manager's session. */
export function oneOnOneUtterance(meeting: Meeting, speaker: string, text: string): string {
  return `${speaker} said in the 1:1 (${meeting.id}): ${text}\n\nAnswer with meeting "speak", then stop and wait.`;
}

/** The human ended the 1:1 (or it went quiet and the town closed it). */
export function oneOnOneEnded(meeting: Meeting): string {
  return `The 1:1 ${meeting.id} is over (the human ended it, or it went quiet and the town closed it). If something was agreed and isn't recorded yet, record it now with meeting "decide" (possible for 5 minutes); then stop. Notes are filed for you.`;
}

/** Whether a human took part in a meeting: a 1:1's human, or any line a human spoke. */
function hadHuman(m: Meeting): boolean {
  return !!m.withUserId || m.transcript.some((u) => u.speakerKind === "user");
}

/**
 * "Decisions from meetings with a human": the decisions (number, text, meeting id, kind, date) of every finished
 * meeting a human took part in, 1:1s included, since this building's last meeting of `meeting`'s kind; the building's
 * own meetings, or every building's for a town hall (town hall mt_1u7mwyjrrz, gr_jh0lu0w6yj step 1).
 */
export function humanDecisionsBlock(world: World, meeting: Pick<Meeting, "id" | "kind" | "buildingId">, limit = 40): string {
  const scope = meeting.buildingId ? "buildingId = ?" : "buildingId IS NULL";
  const scopeArgs = meeting.buildingId ? [meeting.buildingId] : [];
  const last = world.meetings.first(`phase = 'done' AND kind = ? AND ${scope} AND id != ?`, [meeting.kind, ...scopeArgs, meeting.id], "ORDER BY endedAt DESC, rowid DESC");
  const since = last?.endedAt ?? "";
  const where = meeting.buildingId ? "phase = 'done' AND endedAt > ? AND id != ? AND buildingId = ?" : "phase = 'done' AND endedAt > ? AND id != ?";
  const ms = world.meetings.where(where, [since, meeting.id, ...scopeArgs], "ORDER BY endedAt, rowid").filter((m) => hadHuman(m) && m.decisions.some((d) => !d.supersededBy));
  const lines = ms.flatMap((m) => m.decisions.flatMap((d, i) => d.supersededBy ? [] : [`- ${m.id} ${m.kind} ${(m.endedAt ?? m.createdAt).slice(0, 16).replace("T", " ")}Z${!m.buildingId ? "" : meeting.buildingId ? "" : ` (${world.buildings.get(m.buildingId)?.name ?? m.buildingId})`} #${i + 1}: ${oneLine(d.text, 300)}`]));
  const shown = lines.slice(-limit);
  const head = `## Decisions from meetings with a human since the last ${meeting.kind}${last ? ` (${last.id}, ${since.slice(0, 16).replace("T", " ")}Z)` : ""}${meeting.buildingId ? "" : ", every building"}`;
  return `${head}\n${shown.length ? `${lines.length > shown.length ? `(the latest ${shown.length} of ${lines.length})\n` : ""}${shown.join("\n")}` : "(none)"}`;
}

/**
 * A meeting session's full context (town hall mt_1u7mwyjrrz: "residents in meetings should have access to their full
 * context"): the agent's own memory exactly as a work session gets it (wiki and log, or a fork's frozen copy of its
 * manager's), the building's topic index plus the newest page bodies in whatever is left of WIKI_TOTAL_CAP after the
 * wiki (the budget forks use, dc_epn1hq77z2; a cut page says so and gives its id), the decisions of meetings with a
 * human since the last of this kind, and the town-wide FYIs.
 */
export function meetingContextBlock(world: World, agent: Agent, meeting: Pick<Meeting, "id" | "kind" | "buildingId">, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const bid = meeting.buildingId ?? agent.homeBuildingId ?? agent.buildingId ?? "";
  const out: string[] = [agent.forkOf ? forkMemoryBlock(world, agent, null, { now }) : memoryBlock(world, agent.id, { now })];
  const index = agent.forkOf ? "" : topicIndexBlock(world, bid, { now }); // a fork's memory block already carries it
  if (index) out.push(index);
  const wikiChars = agent.forkOf
    ? Math.min(wikiOf(world, agent.forkOf).reduce((n, p) => n + p.body.trim().length, 0), FORK_MANAGER_WIKI_CAP)
    : wikiOf(world, agent.id).reduce((n, p) => n + Math.min(p.body.trim().length, WIKI_PAGE_CAP), 0);
  const budget = Math.max(0, WIKI_TOTAL_CAP - wikiChars);
  const pages = topicPages(world, bid);
  if (pages.length) {
    let used = 0;
    const body: string[] = [];
    for (const p of pages) {
      const text = p.body.trim();
      const room = Math.min(WIKI_PAGE_CAP, budget - used);
      if (room < 300) break;
      body.push(`### ${p.title} (${p.id}, updated ${relativeTime(p.updatedAt, now)})\n${text.length > room ? `${text.slice(0, room)}\n…(cut: page is ${text.length} chars; \`read\` ${p.id} for the rest)` : text}`);
      used += Math.min(text.length, room);
    }
    const rest = pages.length - body.length;
    if (body.length) out.push(`## Topic pages, newest first (${body.length} of ${pages.length}${rest ? `; \`read\` the others from the index above` : ""})\n${body.join("\n\n")}`);
  }
  out.push(humanDecisionsBlock(world, meeting));
  const board = townBoardBlock(world);
  if (board) out.push(board);
  return `# Your full context\n\n${out.join("\n\n")}`;
}

/** `brings` custom: the human's line replaces the Did/Next/Need instructions (Lena's dc_tcoy1plt2r). */
export function summarySystemPrompt(agent: Agent, brings?: Meeting["brings"]): string {
  if (brings?.mode === "custom" && brings.text.trim()) return `You are ${agent.name}, an attendee of a meeting. The humans who called it asked each attendee to bring: "${brings.text.trim()}". Answer that in two or three short lines in plain language, first person, the way you'd say them out loud to colleagues, from your own work below. Keep each line under 25 words. No ids, file paths, jargon, or long numbers; at most one key number with its unit if it matters. No preamble, no markdown. If you have nothing for it, say so in one line; never invent work.`;
  return `You are ${agent.name}, giving your update at a standup. Write two short lines in plain language, first person, the way you'd say them out loud to colleagues:
Did: what I did since the last meeting, against what I said I'd do there, in one sentence; say plainly if something I promised didn't happen.
Next: what I'll do next, in one sentence.
Add a third line "Need: ..." only if something blocks you or a human must act. Keep each line under 20 words. No ids, file paths, jargon, or long numbers; at most one key number with its unit if it matters. No preamble, no markdown. If you have done nothing yet, say so on the Did line.`;
}

/** What an attendee said and was assigned at the previous meeting of the same scope ("did" against "said"). */
export interface LastMeetingForAttendee { title: string; said: string | undefined; decisions: DecisionOutcome[] }

export function lastMeetingFor(world: World, meeting: Meeting, agentId: string): LastMeetingForAttendee | null {
  const prev = previousMeeting(world, meeting);
  return prev ? { title: prev.title, said: prev.summaries[agentId], decisions: decisionOutcomes(world, prev, agentId) } : null;
}

export function summaryPrompt(meeting: Meeting, lastReport: Doc | undefined, events: Event[], recentWork?: string, last?: LastMeetingForAttendee | null, context?: string): string {
  const lastBlock = last
    ? `Last meeting ("${last.title}"):\nLast time you said: ${last.said?.replace(/\n/g, " / ") ?? "(no summary)"}\nDecisions assigned to you last time:\n${last.decisions.map((d) => `- ${oneLine(d.text, 200)} → ${d.outcome}`).join("\n") || "(none)"}`
    : "Last meeting: (none; first meeting)";
  return `Meeting: ${meeting.title} (${meeting.kind}). Agenda: ${meeting.agenda || "(none)"}

${lastBlock}

My latest report: ${lastReport ? `"${lastReport.title}" (decision ${lastReport.decision ?? "?"})\n${trunc(lastReport.body, 4000)}` : "(none yet)"}
${recentWork ? `\n${recentWork}\n` : ""}
My recent activity:
${events.map((e) => `- ${e.ts.slice(0, 16)} ${e.text}`).join("\n") || "(none)"}${context ? `\n\n${context}` : ""}`;
}

export function facilitateSystemPrompt(facilitator: Agent, building: Building | undefined, town: Town, context?: string): string {
  return `You are ${facilitator.name}, facilitating a meeting in ${building?.name ?? "Town Hall"} of ${town.name}. Building goal: ${building?.goal || town.goal || "(none)"}

You run the meeting with the \`meeting\` tool (mcp__town__meeting) like everyone else. Be brief and concrete. Humans may speak in the meeting; their words carry weight. Do not call submit_report.${standingRules(building)}${context ? `\n\n${context}` : ""}`;
}

/**
 * The building's material for the facilitator (town hall 2026-10-24, docs/meetings.md §3.2): the in-tray (a lab's
 * pending reports with their "What I need from you" line; the Town Hall's manager reports plus per-building counts),
 * the previous meeting's decisions with outcomes, and the "Need:" lines of this meeting's summaries.
 */
/** A presentation meeting (gr_jh0lu0w6yj step 5): the slide on screen now, whole, with how slide moves show up. "" for a chat meeting. */
export function presentingBlock(world: World, meeting: Meeting): string {
  const s = currentSlide(world, meeting);
  if (!s) return "";
  if (!s.count) return `Presenting: "${s.deckTitle}" (no slides yet).\n\n`;
  return `Presenting: "${s.deckTitle}", slide ${s.n} of ${s.count}${s.title ? ` "${s.title}"` : ""}. Everyone sees it above the chat. When the presenter moves on, the transcript gets a line "— slide n: <title>", and \`meeting\` status and listen return the current slide (\`slide\`). When a human talks about a slide, answer about that slide, or @mention the manager of the building it concerns. A human decides on the slide's own buttons; that decision is added to this meeting's decisions for you, so don't record it again.
The slide on screen now:
${s.text || "(no text)"}${s.notes ? `\nPresenter notes: ${s.notes}` : ""}

`;
}

export function facilitateMaterial(world: World, meeting: Meeting): string {
  const nameOf = (id: string) => world.nameOf(id);
  const need = (d: Doc) => { const n = sectionOf(d.body, NEED).split("\n").map((l) => l.trim()).find(Boolean) ?? ""; return n ? ` — needs: ${oneLine(n, 200)}` : ""; };
  const row = (d: Doc) => `- ${d.id} "${oneLine(d.title, 100)}" by ${nameOf(d.authorId)} (verdict ${d.verdict ?? "?"})${need(d)}`;
  let intray: string;
  if (meeting.buildingId) {
    intray = intrayOf(world, meeting.buildingId).map(row).join("\n") || "(empty)";
  } else {
    const th = world.buildings.first("kind = 'town-hall'");
    const counts = [...intrayCounts(world)].filter(([bid]) => bid !== th?.id).map(([bid, n]) => `- ${world.buildings.get(bid)?.name ?? bid}: ${n} pending report(s) in its in-tray`);
    intray = [...(th ? intrayOf(world, th.id).map(row) : []), ...counts].join("\n") || "(empty)";
  }
  const prev = previousMeeting(world, meeting);
  const last = prev ? `("${prev.title}"):\n${decisionOutcomes(world, prev).map((d) => `- ${d.n}. ${oneLine(d.text, 200)}${d.assigneeId ? ` → ${nameOf(d.assigneeId)}` : ""}: ${d.outcome}`).join("\n") || "(no decisions)"}` : "(none; first meeting)";
  const needs = meeting.attendeeIds.flatMap((id) => (meeting.summaries[id] ?? "").split("\n").filter((l) => /^need:/i.test(l.trim())).map((l) => `- ${nameOf(id)}: ${l.trim().replace(/^need:\s*/i, "")}`)).join("\n") || "(none)";
  // a reorg meeting ("Change this goal"): the change, the prep reports, the proposals and the under-review key results first
  const reorg = world.reorgs.material(meeting);
  return `${reorg ? `${reorg}

` : ""}${presentingBlock(world, meeting)}In-tray (${meeting.buildingId ? "this building's pending reports" : "the Town Hall's: managers' rollups and proposals, then each building's count"}):
${intray}

Last meeting's decisions and what became of them ${last}

Needs (the "Need:" lines of the summaries above):
${needs}`;
}

export function facilitatePrompt(meeting: Meeting, nameOf: (id: string) => string, material?: string): string {
  const summaries = meeting.attendeeIds.map((id) => `- ${nameOf(id)} (${id}): ${meeting.summaries[id]?.replace(/\n/g, " / ") ?? "(no summary)"}`).join("\n");
  const transcript = meeting.transcript.slice(-20).map((u) => `- ${nameOf(u.speakerId)}: ${u.text}`).join("\n");
  const askHumans = meeting.askHumans;
  const agenda = meeting.agenda.trim();
  const brought = meeting.brings.mode === "nothing" ? "Attendees were asked to bring nothing (no summaries): ask them with @Name when you need their view."
    : meeting.brings.mode === "custom" ? `Attendees were asked to bring: "${meeting.brings.text}". Their answers:` : "Attendees and their summaries:";
  return `Facilitate meeting ${meeting.id}: "${meeting.title}" (${meeting.kind}).
${agenda ? `Agenda set by the humans who called it. Cover these, in order, before your own items:\n${agenda}` : "Agenda: (none; summarise what's going on from the material below and propose 2-4 items)"}

${brought}
${meeting.brings.mode === "nothing" ? meeting.attendeeIds.map((id) => `- ${nameOf(id)} (${id})`).join("\n") || "(none)" : summaries || "(none)"}
${material ? `\n${material}\n` : ""}
Transcript so far:
${transcript || "(empty)"}

Steps:
1. \`meeting\` action "speak": ${meeting.transcript.length ? `the transcript above is not empty, so this is a pick-up after a server restart: say "picking up after a restart" in one line and carry on from where it left off (do not repeat an opening that is already there). Otherwise ` : ""}${askHumans
    ? `open with "Decisions needed from the humans": the yes/no questions drawn from the Needs and in-tray lines above (none: say so in one line), then ${agenda ? "the agenda above, in its order" : "a short agenda (2-4 lines)"}. This meeting is for getting decisions from the humans; settle agent-to-agent back-and-forth outside the meeting, not in it.`
    : agenda ? "open with the agenda above, in its order (add at most 2 items of your own after it, from the material above), then take the items one at a time."
    : "open with a short agenda (2-4 lines) drawn from the summaries and the material above: unresolved Needs and in-tray items first."}
2. Loop: \`meeting\` action "listen" with waitSeconds 60, and answer with "speak" when someone asks something. A human in the meeting may send several messages; keep listening and responding to each one. To question an attendee, write @Name in a "speak": they get a short turn and answer in the meeting, and their reply shows up in your next listens.
3. \`meeting\` action "decide" with 1-5 decisions once the discussion has settled (you can decide again if more come up). Give each actionable decision an assigneeId from the attendee ids above (it becomes their next assignment); use null for general decisions. To change a decision you already recorded, decide again with \`supersedes\` set to its number \`n\` from status: its assignment is rewritten (same assignee) or cancelled, never duplicated.
4. If a human is taking part, they close the meeting with the End meeting button: keep listening until listen returns phase "done". If the meeting closed before you recorded decisions, call \`meeting\` action "decide" right then with everything that was agreed or asked for (you have a few minutes after close; anything a human asked for that someone should do is a decision with an assigneeId), then stop. Listen and status say humanTyping: true while a human has an unsent message in the say box; keep listening then, and never end the meeting under them. Otherwise (or once humans have been quiet for a few minutes) use \`meeting\` action "end" with a one-line closing, then stop.`;
}

export function meetingReplySystemPrompt(agent: Agent): string {
  return `You are ${agent.name}, an attendee of a meeting. Someone addressed you with @${agent.name}. Reply to them in the meeting chat, in first person, from your own work context below: 1-4 short sentences, no preamble, no @tags unless you are asking someone something. Numbers carry units. If you don't know or haven't done the work, say so; never invent findings. Tools this turn: \`read\` (mcp__town__read) a doc if someone asks about one, \`search\` the library if you need a fact you filed; otherwise answer from your context. Post the reply with the \`meeting\` tool, action "speak" (the meeting id is below); if you only write it, it is posted for you. One reply, then stop.`;
}

export function meetingReplyPrompt(meeting: Meeting, nameOf: (id: string) => string, ctx: { assignment: Assignment | undefined; lastReport: Doc | undefined; events: Event[]; recentWork?: string }): string {
  const transcript = meeting.transcript.slice(-20).map((u) => `- ${nameOf(u.speakerId)}: ${u.text}`).join("\n");
  return `Meeting: ${meeting.title} (${meeting.kind}, meetingId ${meeting.id}). Agenda: ${meeting.agenda || "(none)"}

Transcript (latest last; answer the latest message that addresses you):
${transcript || "(empty)"}

My current assignment: ${ctx.assignment ? `${ctx.assignment.title} (${ctx.assignment.status})\n${trunc(ctx.assignment.description, 1000)}` : "(none)"}

My latest report: ${ctx.lastReport ? `"${ctx.lastReport.title}" (decision ${ctx.lastReport.decision ?? "?"})\n${trunc(ctx.lastReport.body, 3000)}` : "(none yet)"}
${ctx.recentWork ? `\n${ctx.recentWork}\n` : ""}
My recent activity:
${ctx.events.map((e) => `- ${e.ts.slice(0, 16)} ${e.text}`).join("\n") || "(none)"}`;
}

export function fallbackReportBody(finalText: string, error: string | null, assignment: Assignment | undefined): string {
  return `## What I did
Assignment: ${assignment ? assignment.title : "(none)"}. The session ended without \`submit_report\`${error ? ` (error: ${error})` : ""}; this is a fallback report written by the runtime.

## Findings
${finalText.trim() || "(no final message)"}

## What I need from you
${error ? "Nothing needed unless the task still matters: the session failed before it could work, so re-assign it once the cause above is fixed." : "Nothing needed."}
`;
}

/** Extra system prompt for buildings with a workspace: the agent edits code in its own checkout inside its desk. */
export function workshopPrompt(ws: { dir: string; branch: string; base: string }, repoName: string): string {
  return `

## Code access
You can edit the ${repoName} repository. Your own checkout is at ${ws.dir} on branch \`${ws.branch}\` (forked from \`${ws.base}\`); it is your current working directory. Nobody else edits it. Rules:
- Read the repo's AGENTS.md and CLAUDE.md first, then the files you need. Keep the change small and complete.
- Run \`npm run typecheck\` and the relevant package's tests before you commit. Don't commit broken code.
- Commit with a clear message, then \`git push -u origin ${ws.branch}\` and open a draft pull request with \`gh pr create --draft --fill\` (base ${ws.base}). Put the PR URL in your report. To wait for its CI, park with \`submit_report\` \`resumeWhen: {pr: <number>}\`: you resume when its checks pass or fail.
- Never force-push, never rewrite history, never run destructive commands.
- If you call \`redeploy\`, your session keeps running through the restart (a town call in the few seconds the server is down is retried for you). Never wait or poll for the new build in the same session: say which commit should be live in your report, submit it, and verify next time.
- The town library is still where you write source cards and notes; your report must say what changed, how you verified it, and link the PR.`;
}

/** Slug for branch and directory names. */
export function branchSlug(x: string, n = 40): string {
  return x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "work";
}

/** "https://github.com/o/agent-town.git" | "git@github.com:o/agent-town.git" → "agent-town". */
/** Containers have no SSH keys: turn `git@github.com:owner/repo.git` / `ssh://git@host/owner/repo` into https. */
export function httpsRepoUrl(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

export function repoNameOf(repoUrl: string): string {
  return repoUrl.replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "") || "repo";
}

/** The collective repo a building's residents work on: the town's workspace when the building has code access. */
export function codeWorkspace(town: Town, building: Building | undefined): Workspace | undefined {
  return building?.codeAccess ? town.workspace : undefined;
}

/** Where a desk checks out the collective's repo for this agent + assignment (undefined without code access or repoUrl). */
export function deskWorkspace(town: Town, building: Building, agent: Agent, assignment: Assignment | null | undefined): DeskWorkspace | undefined {
  const ws = codeWorkspace(town, building);
  if (!ws?.repoUrl) return undefined;
  const branch = `${ws.branchPrefix}/${branchSlug(agent.name, 20)}/${branchSlug(assignment?.title ?? "work")}`;
  return {
    repoUrl: httpsRepoUrl(ws.repoUrl), base: ws.base, branch, branchPrefix: ws.branchPrefix, dir: `/home/agent/work/${repoNameOf(ws.repoUrl)}`,
  };
}

/** The agent's latest report (any decision), for "your previous report" in the work prompt. */
export function latestReportOf(world: World, agentId: string): Doc | undefined {
  return world.docs.first("authorId = ? AND type = 'report'", [agentId], "ORDER BY createdAt DESC, rowid DESC");
}

/** Everything a desk needs to run work session `sessionId` (GET /api/agents/me/brief). */
export function composeWorkBrief(world: World, sessionId: string): DeskBrief {
  const session = world.sessions.require(sessionId, "session");
  const agent = world.agents.require(session.agentId, "agent");
  const bid = agent.homeBuildingId ?? agent.buildingId;
  if (!bid) throw new Error(`${agent.name} has no building`);
  const building = world.buildings.require(bid, "building");
  const town = world.town.get();
  const assignment = session.assignmentId ? world.assignments.get(session.assignmentId) ?? null : null;
  const workspace = deskWorkspace(town, building, agent, assignment);
  const system = workSystemPrompt(agent, building, town, { desk: true, ...sessionMemory(world, agent, building, assignment), skills: skillsBlock(world.skills.forAgent(agent.id)) }) + (workspace ? workshopPrompt(workspace, repoNameOf(workspace.repoUrl)) : "");
  const recent = recentWorkBlock(world, agent.id, { excludeSessionId: session.id });
  const prompt = assignment
    ? workPrompt(assignment, world.docs.first("authorId = ? AND type = 'report' AND (sessionId IS NULL OR sessionId != ?)", [agent.id, session.id], "ORDER BY createdAt DESC, rowid DESC"), recent,
      agent.forkOf ? chainBlock(world, assignment, session.id) : undefined)
    : `${CHECK_IN}\n\n${recent}\n\nStart with \`look\`, then the board. End with \`submit_report\`.`;
  return { agent, building, town, assignment, session, system, prompt, ...(workspace ? { workspace } : {}) };
}
