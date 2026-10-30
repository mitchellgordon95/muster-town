import { Agent, ChangeGoalInput, ReviewKeyResultInput, ROOT_GOAL_ID, type GoalChange, type GoalChangeView, type KeyResult, type Meeting } from "@muster-town/schema";
import { createAssignment, createDoc, managerAgentOf } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import type { GoalNode } from "./goals.ts";
import { createMeeting, createOneOnOne, defaultFacilitator, meetingNotice } from "./meetings.ts";
import type { Actor } from "./ops.ts";
import { holderOf } from "./permissions.ts";
import { oneLine } from "./text.ts";
import { newId, nowIso } from "./util.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

/** The planning meeting opens this long after a change is filed if a prep report is still missing (1:1 mt_kh0zaqui0w). */
export const REORG_PREP_MS = 24 * 60 * 60_000;
/** The Planner's title: a Town Hall resident (docs/goals.md "The planning agent"). */
export const PLANNER_TITLE = "Planner";
const PLANNER_DIRECTION = "The town's planning agent: drafts goal-tree changes as proposals a human accepts or cuts (it never edits the tree) and facilitates the reorg meetings of \"Change this goal\".";

/** Posted in a Planner 1:1 when the Planner can't start a session (the Town Hall draws nothing from the Bank until docs/goals.md step 7). */
export const PLANNER_UNPAID = "The Planner can't start a session yet: it lives at the Town Hall, and the Town Hall draws nothing from the Bank (paying the Planner is Bank work, docs/goals.md step 7, waiting on Mitchell). Your lines are kept; it answers once it can run.";

const isOpenKr = (k: KeyResult) => !k.archivedAt && k.status !== "met" && k.status !== "missed";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * "Change this goal" (the reorg) and the Planner (docs/goals.md, build step 5). A human with `goals.edit` at a goal files
 * X → Y: a note doc (the human source), a `goal_changes` row, one directed prep assignment per building attached under
 * the goal, "under review" on every open key result there, and a planning meeting at the Town Hall facilitated by the
 * Planner. The meeting opens when every prep report is in, or 24 h after filing, whichever comes first (the runtime
 * starts a scheduled meeting at its `scheduledAt`; `tick` moves it earlier). The goal's text becomes Y when the meeting
 * starts; the change is decided when it ends. No money moves: grants keep running until a human cuts them.
 */
export class Reorgs {
  constructor(private world: World) {}

  // ---- the Planner ----
  /** The Planner, if it has been created. */
  planner(): Agent | undefined {
    return this.world.agents.first("homeBuildingId = ? AND kind = 'resident' AND title = ? AND forkOf IS NULL AND status NOT IN ('banned', 'retired')", [TOWN_HALL_ID, PLANNER_TITLE], "ORDER BY createdAt");
  }

  isPlanner(a: Actor): boolean {
    if (!a) return false;
    const p = this.planner();
    return !!p && (a.id === p.id || a.forkOf === p.id);
  }

  /** The Planner, created on first use: a Town Hall resident seated at a free mod-station seat (else by the door). */
  ensurePlanner(): Agent {
    const have = this.planner();
    if (have) return have;
    const th = this.world.buildings.require(TOWN_HALL_ID, "building");
    return this.world.transaction(() => {
      const id = newId("ag");
      this.world.agents.upsert(Agent.parse({
        id, name: PLANNER_TITLE, kind: "resident", buildingId: th.id, homeBuildingId: th.id, ownerUserId: th.createdBy ?? null,
        title: PLANNER_TITLE, sprite: 5, direction: PLANNER_DIRECTION, pos: this.world.layout.door(th.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
      }), { silent: true });
      let agent = this.world.agents.require(id, "agent");
      try { agent = this.world.agents.patch(id, { pos: this.world.layout.claimDesk(th.id, id).pos }); }
      catch (e) { if (!(e instanceof AppError) || e.code !== "conflict") throw e; }
      this.world.events.append({ type: "agent.created", agentId: id, buildingId: th.id, text: `${agent.name} (the planning agent) joined the Town Hall`, payload: { kind: "resident", planner: true } });
      return agent;
    });
  }

  /** Can the Planner start a session now? The Town Hall draws nothing from the Bank (bank.ts drawPool), so only its own allocations pay. */
  canRun(): boolean {
    const p = this.planner();
    return !!p && p.status !== "stopped" && this.world.budget.canStart(p.id);
  }

  /** Who may plan with the Planner: an admin (`goals.edit`), or the owner of the goal it is about (or of any goal). */
  canPlan(actor: Actor, goalId?: string): boolean {
    if (!actor) return true;
    if (holderOf(actor).kind !== "user") return false;
    if (this.world.permissions.can(actor, "goals.edit") || this.world.permissions.can(actor, "meeting.facilitate", TOWN_HALL_ID)) return true;
    if (goalId) return this.world.goalTree.canEdit(actor, goalId);
    const uid = holderOf(actor).id;
    return this.world.goals.where("ownerId = ?", [uid]).length > 0;
  }

  /** "Plan with an agent": open (or return to) the human's 1:1 with the Planner, about `goalId` when started from a goal. */
  openPlanner(human: Agent, goalId?: string): Meeting {
    if (goalId) this.world.goalTree.require(goalId);
    if (!this.canPlan(human, goalId)) throw forbidden("goals.edit", "Only an admin or a goal's owner plans with the Planner.");
    const planner = this.ensurePlanner();
    const m = createOneOnOne(this.world, human, TOWN_HALL_ID, { agentId: planner.id, goalId });
    if (this.canRun() || m.transcript.some((u) => u.text === PLANNER_UNPAID)) return m;
    return meetingNotice(this.world, m.id, PLANNER_UNPAID) ?? m;
  }

  /** The reorg meeting's facilitator: the Planner when it can run, else the default (the first active manager invited). */
  private facilitatorFor(attendees: string[]): string | null {
    const p = this.planner();
    if (p && this.canRun()) return p.id;
    return defaultFacilitator(this.world, null, attendees.filter((id) => id !== p?.id)) ?? p?.id ?? null;
  }

  // ---- "Change this goal" ----
  get(id: string): GoalChange | undefined { return this.world.goalChanges.get(id); }

  /** Changes newest first; `open` = not decided yet. */
  list(opts: { goalId?: string; open?: boolean } = {}): GoalChangeView[] {
    const where = [opts.goalId && "goalId = ?", opts.open && "status != 'decided'"].filter(Boolean).join(" AND ") || "1 = 1";
    return this.world.goalChanges.where(where, opts.goalId ? [opts.goalId] : [], "ORDER BY createdAt DESC, rowid DESC").map((c) => this.view(c));
  }

  /** File X → Y on a goal (an admin or its owner). Refused while another change of the same goal is open. */
  file(actor: Actor, goalId: string, input: ChangeGoalInput): GoalChangeView {
    const inp = ChangeGoalInput.parse(input);
    const goal = this.world.goalTree.require(goalId);
    if (goal.status !== "active") throw badRequest(`Goal ${goalId} is retired.`);
    if (actor && holderOf(actor).kind !== "user") throw forbidden("goals.edit", "Only a human changes a goal; managers propose with propose_goal.");
    this.world.goalTree.requireEdit(actor, goal.id);
    if (inp.toText === goal.text) throw badRequest("The new words are the same as the old: say what the goal becomes.");
    const open = this.world.goalChanges.first("goalId = ? AND status != 'decided'", [goal.id]);
    if (open) throw new AppError("conflict", `"${clip(goal.text, 60)}" already has a change under way (${open.id}, ${open.status}): finish its meeting first.`);
    const by = actor ? holderOf(actor) : { kind: "user" as const, id: "system" };
    const planner = this.ensurePlanner();
    return this.world.transaction(() => {
      const now = new Date();
      const createdAt = now.toISOString();
      const id = newId("gc");
      const sub = this.world.goalTree.subtreeIds(goal.id);
      const buildings = this.world.buildings.all().filter((b) => b.kind !== "town-hall" && sub.has(this.world.goalTree.attachmentOf(b)));
      const note = createDoc(this.world, {
        type: "note", state: "building", buildingId: TOWN_HALL_ID, authorId: by.id, authorKind: by.kind === "user" ? "user" : "agent",
        title: `Change this goal: ${clip(goal.text, 80)} → ${clip(inp.toText, 80)}`,
        body: `# Change this goal\n\n**From:** ${goal.text}\n\n**To:** ${inp.toText}\n\n## Why\n\n${inp.why}\n\nGoal: ${goal.id} (${this.world.goalTree.pathText(goal.id)}). Change: ${id}. Each building attached under it gets a prep assignment; the planning meeting opens when every prep report is in, or 24 h after this note, whichever comes first.`,
      });
      const managed = buildings.map((b) => ({ b, mgr: managerAgentOf(this.world, b) })).filter((x) => !!x.mgr);
      const deadline = new Date(now.getTime() + REORG_PREP_MS).toISOString();
      // nothing to wait for: the meeting opens at once
      const opensAt = managed.length ? deadline : createdAt;
      const attendees = [...new Set([planner.id, ...managed.map((x) => x.mgr!.id)])];
      let meeting = createMeeting(this.world, {
        kind: "planning", buildingId: null, title: `Reorg: ${clip(inp.toText, 80)}`, scheduledAt: opensAt, attendeeIds: attendees,
        brings: { mode: "nothing", text: "" }, askHumans: true,
        agenda: [`The change: "${clip(goal.text, 120)}" → "${clip(inp.toText, 120)}" (${id}; why in ${note.id})`, "Each manager presents its proposals (reorgId " + id + "); the human accepts or cuts each in the Goal tree", "Under-review key results: Keep, Move or Archive each"],
      });
      meeting = this.world.meetings.upsert({ ...meeting, facilitatorId: this.facilitatorFor(attendees) });
      const change = this.world.goalChanges.upsert({
        id, goalId: goal.id, fromText: goal.text, toText: inp.toText, why: inp.why, meetingDeadline: deadline, meetingId: meeting.id, sourceDocId: note.id,
        status: "prep", createdBy: by.id, createdAt, decidedAt: null,
      });
      for (const { b, mgr } of managed) {
        createAssignment(this.world, {
          agentId: mgr!.id, queue: "building", buildingId: b.id, createdBy: by,
          title: `Reorg prep: review your work against "${clip(inp.toText, 80)}"`,
          description: `A human is changing the goal "${goal.text}" (${goal.id}) to "${inp.toText}" (change ${id}; their note ${note.id}).\n\nWhy: ${inp.why}\n\nReview your work against the new goal. Bring proposals for what goes underneath (propose_goal / propose_key_result with reorgId ${id}), and say in your report which of your key results and grants still serve it. Your key results under this goal are marked "under review"; their grants keep running until a human cuts them. The planning meeting (${meeting.id}) opens when every attached building's prep report is in, or at ${deadline}, whichever comes first.`,
          lane: { lane: "directed", sourceId: note.id },
        });
      }
      for (const k of this.world.keyResults.where("goalId IS NOT NULL").filter((k) => sub.has(k.goalId!) && isOpenKr(k))) {
        this.world.keyResults.upsert({ ...k, underReviewSince: createdAt, updatedAt: createdAt });
        this.world.events.append({ type: "kr.under-review", agentId: null, buildingId: k.buildingId, text: `Key result under review (reorg ${id}): ${k.text}`, payload: { keyResultId: k.id, goalId: k.goalId, changeId: id, action: "flagged", by: by.id } });
      }
      this.event(change, `${this.world.nameOf(by.id)} filed "Change this goal": ${clip(goal.text, 80)} → ${clip(inp.toText, 80)}`, "filed", by.id);
      return this.view(change);
    });
  }

  /** Move a change's meeting up to now once every prep report is in (the runtime starts scheduled meetings when due). */
  tick(now = new Date()): void {
    for (const c of this.world.goalChanges.where("status = 'prep'")) {
      const m = c.meetingId ? this.world.meetings.get(c.meetingId) : undefined;
      if (!m) continue;
      if (m.phase !== "scheduled") { this.onMeetingPhase(m); continue; }
      if (Date.parse(m.scheduledAt) <= now.getTime()) continue;
      if (this.prepOf(c).every((p) => p.status !== "waiting")) this.world.meetings.upsert({ ...m, scheduledAt: now.toISOString() });
    }
  }

  /** The meeting moved: it started (the goal text becomes Y) or ended (the change is decided). Wired to meeting.phase events. */
  onMeetingPhase(m: Meeting): void {
    const c = this.world.goalChanges.first("meetingId = ? AND status != 'decided'", [m.id]);
    if (!c) return;
    const live = m.phase === "collecting" || m.phase === "discussing";
    if (live && c.status === "prep") {
      // the facilitator is picked again as it opens: the Planner if it can run now, else a manager in the room
      const fac = this.facilitatorFor(m.attendeeIds);
      if (fac !== m.facilitatorId) this.world.meetings.upsert({ ...m, facilitatorId: fac });
      const g = this.world.goalTree.get(c.goalId);
      if (g && g.status === "active" && g.text !== c.toText) this.world.goalTree.update(null, g.id, { text: c.toText });
      const next = this.world.goalChanges.upsert({ ...c, status: "meeting" });
      this.event(next, `Reorg meeting opened: "${clip(c.fromText, 60)}" is now "${clip(c.toText, 60)}"`, "meeting");
    } else if (m.phase === "done" || m.phase === "cancelled") {
      const next = this.world.goalChanges.upsert({ ...c, status: "decided", decidedAt: nowIso() });
      this.event(next, `Reorg ${m.phase === "done" ? "decided" : "closed (meeting cancelled)"}: ${clip(c.toText, 80)}`, "decided");
    }
  }

  /** Each building attached under the goal: its prep assignment and whether its report is in. */
  prepOf(c: GoalChange): GoalChangeView["prep"] {
    const sub = this.world.goalTree.subtreeIds(c.goalId);
    const buildings = this.world.buildings.all().filter((b) => b.kind !== "town-hall" && sub.has(this.world.goalTree.attachmentOf(b)));
    const work = c.sourceDocId ? this.world.assignments.where("sourceId = ?", [c.sourceDocId], "ORDER BY createdAt, rowid") : [];
    // buildings that had a prep assignment but moved away since still count
    const ids = [...new Set([...buildings.map((b) => b.id), ...work.map((a) => a.buildingId)])];
    return ids.map((bid) => {
      const mine = work.filter((a) => a.buildingId === bid);
      const done = mine.filter((a) => a.status === "done" && a.reportId).at(-1);
      const busy = mine.some((a) => a.status === "pending" || a.status === "active");
      const status = !mine.length ? "no-manager" : done && !busy ? "in" : mine.every((a) => a.status === "cancelled") ? "in" : "waiting";
      return { buildingId: bid, buildingName: this.world.buildings.get(bid)?.name ?? bid, assignmentId: (done ?? mine.at(-1))?.id ?? null, reportId: done?.reportId ?? null, status };
    });
  }

  view(c: GoalChange): GoalChangeView {
    const sub = this.world.goalTree.subtreeIds(c.goalId);
    return {
      ...c, createdByName: c.createdBy ? this.world.nameOf(c.createdBy) : "the town", prep: this.prepOf(c),
      meetingPhase: c.meetingId ? this.world.meetings.get(c.meetingId)?.phase ?? null : null,
      underReview: this.world.keyResults.where("underReviewSince IS NOT NULL AND goalId IS NOT NULL").filter((k) => sub.has(k.goalId!)).map((k) => k.id),
      proposals: this.world.goalProposals.where("reorgId = ?", [c.id], "ORDER BY createdAt, rowid").map((p) => p.id),
    };
  }

  /** A human decides an under-review key result: keep it (clears the flag), move it to another goal, or archive it as missed. */
  reviewKr(actor: Actor, krId: string, input: ReviewKeyResultInput): KeyResult {
    const inp = ReviewKeyResultInput.parse(input);
    const kr = this.world.keyResults.require(krId, "key result");
    if (!kr.underReviewSince) throw new AppError("conflict", `Key result ${kr.id} is not under review.`);
    if (actor && holderOf(actor).kind !== "user") throw forbidden("goals.edit", "Only a human decides an under-review key result.");
    if (kr.goalId) this.world.goalTree.requireEdit(actor, kr.goalId);
    return this.world.transaction(() => {
      let next = kr;
      if (inp.action === "move") {
        if (!inp.goalId) throw badRequest("Move needs goalId: the goal it goes under.");
        next = this.world.goalTree.moveKr(actor, kr, inp.goalId);
      } else if (inp.action === "archive") {
        next = this.world.grantDesk.updateKeyResult(actor, kr.id, { status: "missed", note: inp.note || "Archived in a reorg (Change this goal)." });
      }
      next = this.world.keyResults.upsert({ ...next, underReviewSince: null, updatedAt: nowIso() });
      const grant = this.world.grantDesk.liveGrantOf(kr.id);
      const by = actor ? holderOf(actor).id : "system";
      this.world.events.append({
        type: "kr.under-review", agentId: actor?.id ?? null, buildingId: kr.buildingId,
        text: `Under-review key result ${inp.action === "keep" ? "kept" : inp.action === "move" ? "moved" : "archived as missed"}: ${kr.text}${inp.action === "archive" && grant ? ` (its grant ${grant.id} is a Cut candidate)` : ""}`,
        payload: { keyResultId: kr.id, goalId: next.goalId, fromGoalId: kr.goalId, action: inp.action, grantId: grant?.id ?? null, by },
      });
      return next;
    });
  }

  // ---- prompts ----
  /** The facilitator's material for a reorg meeting (null for any other meeting). */
  material(m: Meeting): string | null {
    const c = this.world.goalChanges.first("meetingId = ?", [m.id]);
    if (!c) return null;
    const v = this.view(c);
    const nameOf = (id: string) => this.world.nameOf(id);
    const prep = v.prep.map((p) => `- ${p.buildingName}: ${p.status === "in" ? `report ${p.reportId} is in` : p.status === "waiting" ? `still working (${p.assignmentId})` : "no manager, no prep"}`).join("\n") || "(no building is attached under this goal)";
    const proposals = this.world.goalProposals.where("reorgId = ?", [c.id], "ORDER BY createdAt, rowid")
      .map((p) => `- ${p.id} [${p.status}] ${p.action} by ${nameOf(p.proposedBy)}: ${oneLine(p.fields.text ?? p.targetId ?? "", 160)} (why: ${oneLine(p.why, 160)})`).join("\n") || "(none yet)";
    const krs = v.underReview.map((id) => this.world.keyResults.get(id)).filter((k): k is KeyResult => !!k)
      .map((k) => `- ${k.id} [${k.status}${k.due ? `, due ${k.due}` : ""}] ${oneLine(k.text, 160)}${this.world.grantDesk.liveGrantOf(k.id) ? ` (funded grant ${this.world.grantDesk.liveGrantOf(k.id)!.id})` : ""}`).join("\n") || "(none)";
    return `This is the reorg meeting of "Change this goal" ${c.id} (docs/goals.md): ${nameOf(c.createdBy ?? "")} changed "${c.fromText}" → "${c.toText}" (${c.goalId}). Why: ${oneLine(c.why, 600)}. The human's note: ${c.sourceDocId}.

You facilitate it as the Planner. Ask each manager (by @name) to present its proposals; the human accepts or cuts each in the Goal tree (Town Hall), and you record each acceptance as a meeting decision (no assignee unless follow-up work was agreed). Accepted proposals become the goal's new children. Then go through the under-review key results: the human presses Keep, Move or Archive on each in the Goal tree; record what they chose. Present a proposal by attaching its id (gp_…) when you speak. You never edit the tree yourself.

Prep reports:
${prep}

Proposals for this change (reorgId ${c.id}):
${proposals}

Under-review key results:
${krs}`;
  }

  /** The Planner's brief in a 1:1 (null when the 1:1 is with anyone else): the tree, open proposals and changes, scoped to a goal the human named. */
  plannerBrief(m: Meeting): string | null {
    const p = this.planner();
    if (!p || m.facilitatorId !== p.id) return null;
    // the goal the human last named ("Let's plan under the goal … (gl_…)", spoken when they open it from a goal)
    const scoped = m.transcript.filter((u) => u.speakerKind === "user").map((u) => /\(((?:gl|ob)_[a-z0-9]+)\)/.exec(u.text)?.[1]).filter(Boolean).at(-1);
    const scope = scoped && this.world.goals.get(scoped) ? scoped : ROOT_GOAL_ID;
    const tree = this.world.goalTree.tree();
    const find = (n: GoalNode): GoalNode | null => n.id === scope ? n : n.children.map(find).find(Boolean) ?? null;
    const lines: string[] = [];
    const walk = (n: GoalNode, depth: number) => {
      const pad = "  ".repeat(depth);
      const done = n.keyResults.filter((k) => !isOpenKr(k)).length;
      lines.push(`${pad}- ${n.id} "${oneLine(n.text, 140)}" (owner ${n.owner.name}${n.buildings.length ? `; attached: ${n.buildings.map((b) => b.name).join(", ")}` : ""}${done ? `; ${done} archived key results` : ""})`);
      for (const k of n.keyResults.filter(isOpenKr)) lines.push(`${pad}  · ${k.id} [${k.status}${k.due ? `, due ${k.due}` : ", no date"}${k.underReviewSince ? ", under review" : ""}${k.grantId ? `, grant ${k.grantId}` : ", no grant"}] ${oneLine(k.text, 140)}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(find(tree) ?? tree, 0);
    const proposals = this.world.goalTree.listProposals({ status: "open" }).map((x) => `- ${x.id} ${x.action} by ${x.proposedByName}: ${oneLine(x.fields.text ?? x.targetId ?? "", 120)}`).join("\n") || "(none)";
    const changes = this.list({ open: true }).map((c) => `- ${c.id} [${c.status}] "${oneLine(c.fromText, 80)}" → "${oneLine(c.toText, 80)}", meeting ${c.meetingId}`).join("\n") || "(none)";
    return `You are the Planner, the town's planning agent (docs/goals.md "The planning agent"). You help the human shape the town goal tree. You never edit the tree: draft each change as a proposal with \`propose_goal\` (add-goal, edit, move, retire, promote) or \`propose_key_result\` (a dated key result: text, howToCheck, due YYYY-MM-DD, goalId), then speak its id with \`meeting\` speak and attach the proposal id (gp_…) so the human sees it as a card with Accept / Edit and accept / Cut. Anything they don't decide stays in the Goal tree's Proposals strip. Keep proposals few and concrete; ask before drafting many.

The tree${scope !== ROOT_GOAL_ID ? ` under the goal they started from (${scope})` : ""}:
${lines.join("\n")}

Open goal proposals:
${proposals}

Open "Change this goal" reorgs:
${changes}`;
  }

  private event(c: GoalChange, text: string, stage: "filed" | "meeting" | "decided", by?: string): void {
    this.world.events.append({ type: "goal.changed", agentId: null, buildingId: null, text, payload: { goalId: c.goalId, changeId: c.id, stage, fromText: c.fromText, toText: c.toText, meetingId: c.meetingId, by: by ?? "system" } });
  }
}
