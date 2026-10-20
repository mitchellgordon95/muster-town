/** In-memory town for VITE_MOCK=1: holds state, animates it, and implements actions locally. */
import type { Agent, Allocation, Assignment, Building, Doc, Event, Meeting, Membership, Role, ServerMessage } from "@agent-town/schema";
import { BUILTIN_ROLES } from "@agent-town/schema";
import type { Snapshot } from "../api";
import * as F from "./fixture";
import { bfs, computeLayout, type Layout } from "./layout";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();
let seq = 0;
export const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

const SCRIPTS: Record<string, string[]> = {
  default: ["Looking around (look)", "Reading the board", "Searching: {topic}", "Reading doc GCB 2025 ESSD", "Thinking about units and uncertainty", "Writing notes on the board", "Fetching: gml.noaa.gov", "Drafting the report"],
  ag_tomas: ["Searching: TRENDY v13 land sink 2024 anomaly", "Reading doc GCB 2025 ESSD", "Fetching: essd.copernicus.org/articles/17", "Comparing residual land sink to DGVM mean", "Thinking: 2023 El Niño drop vs. trend", "Writing note: land sink 2015–2024", "Searching: Amazon drought 2024 carbon flux"],
};

export class Sim {
  town = clone(F.town);
  buildings: Building[] = clone(F.buildings);
  agents = new Map<string, Agent>(clone(F.agents).map((a) => [a.id, a]));
  docs = new Map<string, Doc>(clone(F.docs).map((d) => [d.id, d]));
  assignments = new Map<string, Assignment>(clone(F.assignments).map((a) => [a.id, a]));
  meetings = new Map<string, Meeting>(clone(F.meetings).map((m) => [m.id, m]));
  events: Event[] = clone(F.events);
  roles: Role[] = clone(F.roles);
  memberships: Membership[] = clone(F.memberships);
  users = clone(F.users);
  allocations: Allocation[] = [{ id: "al_house", userId: "us_mitchell", buildingId: "bl_carbon", tokens: 50_000_000, spentTokens: 3_320_000, spentUsd: 26.5, createdAt: F.ago(9000) }];
  layout!: Layout;
  private subs = new Set<(m: ServerMessage) => void>();
  private eventId = 1000;
  private scriptIdx = new Map<string, number>();
  /** agents whose mock session should end in a report after N activity ticks */
  private sessionLeft = new Map<string, number>();
  private walking = new Set<string>();
  private timers: number[] = [];

  constructor() {
    this.relayout(false);
    for (const a of this.agents.values()) a.pos = this.home(a);
  }

  start() {
    if (this.timers.length) return;
    this.timers.push(window.setInterval(() => this.tickActivity(), 3200));
    this.timers.push(window.setInterval(() => this.wander("ag_moss"), 26000));
    window.setTimeout(() => this.wander("ag_moss"), 2500);
  }

  subscribe(fn: (m: ServerMessage) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(m: ServerMessage) { const c = clone(m); for (const s of this.subs) setTimeout(() => s(c), 0); }

  snapshot(): Snapshot {
    // Unlike the real server, the mock keeps retired agents in the snapshot so the client's filter is exercised.
    return clone({
      type: "snapshot", town: this.town, buildings: this.buildings.map((b) => ({ ...b, intray: this.intrayCount(b.id), budget: this.budgetOf(b.id) })),
      agents: [...this.agents.values()].filter((a) => a.status !== "banned"), places: this.layout.places, grid: this.layout.grid,
      meetings: [...this.meetings.values()].filter((m) => m.phase !== "done" && m.phase !== "cancelled"),
    });
  }

  /** Pending reports for a building, oldest first (GET /api/buildings/:id/intray). */
  intray(buildingId: string): Doc[] {
    return [...this.docs.values()].filter((d) => d.type === "report" && d.decision === "pending" && d.buildingId === buildingId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  intrayCount(buildingId: string) { return this.intray(buildingId).length; }
  budgetOf(buildingId: string) {
    const al = this.allocations.filter((a) => a.buildingId === buildingId);
    const allocatedTokens = al.reduce((s, a) => s + a.tokens, 0), spentTokens = al.reduce((s, a) => s + a.spentTokens, 0);
    return { allocatedTokens, spentTokens, remainingTokens: Math.max(0, allocatedTokens - spentTokens) };
  }
  /** Resend a building with its in-tray count (the server does this when reports are created or decided). */
  emitBuilding(buildingId: string | null) {
    const b = this.buildings.find((x) => x.id === buildingId);
    if (b) this.emit({ type: "building", building: { ...b, intray: this.intrayCount(b.id) } });
  }

  relayout(broadcast = true) {
    this.layout = computeLayout(this.buildings, [...this.agents.values()]);
    for (const b of this.buildings) {
      const lot = this.layout.lots.get(b.id);
      if (lot && JSON.stringify(lot) !== JSON.stringify(b.lot)) { b.lot = lot; if (broadcast) this.emit({ type: "building", building: b }); }
    }
    if (broadcast) for (const a of this.agents.values()) if (!this.walking.has(a.id) && a.kind !== "human" && a.status !== "retired") { a.pos = this.home(a); this.emit({ type: "agent", agent: a }); }
  }

  home(a: Agent) {
    const pl = this.layout.places;
    const at = (id: string) => pl.find((p) => p.id === id)?.pos;
    if (a.kind === "service") return { ...(at("library") ?? { x: 2, y: 2 }) };
    if (a.kind === "human") return { ...(at("plaza") ?? { x: 2, y: 2 }) };
    return { ...(at(`desk:${a.id}`) ?? at(`door:${a.homeBuildingId}`) ?? { x: 2, y: 2 }) };
  }

  event(type: Event["type"], agentId: string | null, text: string, payload: Record<string, unknown> = {}, buildingId: string | null = "bl_carbon") {
    const e: Event = { id: ++this.eventId, ts: now(), type, agentId, buildingId, text, payload };
    this.events.push(e);
    if (this.events.length > 2000) this.events.shift();
    this.emit({ type: "event", event: e });
    return e;
  }
  patchAgent(id: string, patch: Partial<Agent>) {
    const a = this.agents.get(id); if (!a) return;
    Object.assign(a, patch);
    this.emit({ type: "agent", agent: a });
  }
  putDoc(d: Doc) { d.updatedAt = now(); this.docs.set(d.id, d); this.emit({ type: "doc", doc: d }); return d; }
  putAssignment(a: Assignment) { a.updatedAt = now(); this.assignments.set(a.id, a); this.emit({ type: "assignment", assignment: a }); return a; }
  putMeeting(m: Meeting) { this.meetings.set(m.id, m); this.emit({ type: "meeting", meeting: m }); return m; }

  // ---------- animation ----------
  private tickActivity() {
    for (const a of this.agents.values()) {
      if (a.status !== "working") continue;
      const script = SCRIPTS[a.id] ?? SCRIPTS.default;
      const i = (this.scriptIdx.get(a.id) ?? 0) % script.length;
      this.scriptIdx.set(a.id, i + 1);
      const asg = a.currentAssignmentId ? this.assignments.get(a.currentAssignmentId) : null;
      const text = script[i].replace("{topic}", asg?.title ?? a.title);
      const type = /^Thinking/.test(text) ? "agent.thought" : "agent.tool";
      a.activity = text;
      a.spentTokensToday += 18_000; a.spentTokensTotal += 18_000; a.spentUsdTotal = +(a.spentUsdTotal + 0.14).toFixed(2);
      this.event(type, a.id, text, { activity: text });
      this.emit({ type: "agent", agent: a });
      const al = this.allocations.find((x) => x.buildingId === a.homeBuildingId && x.spentTokens < x.tokens);
      const home = this.buildings.find((b) => b.id === a.homeBuildingId);
      if (al && home) { al.spentTokens += 18_000; this.emit({ type: "building", building: { ...home, budget: this.budgetOf(home.id) } }); }
      const left = this.sessionLeft.get(a.id);
      if (left !== undefined) { if (left <= 1) this.finishSession(a); else this.sessionLeft.set(a.id, left - 1); }
    }
  }

  wander(id: string, to?: { x: number; y: number }, then?: () => void) {
    const a = this.agents.get(id);
    if (!a || this.walking.has(id) || a.status === "working" || a.status === "in-meeting") return;
    const lib = this.layout.places.find((p) => p.id === "library")!.pos;
    const atHome = a.pos.x === this.home(a).x && a.pos.y === this.home(a).y;
    const dest = to ?? (atHome ? { x: lib.x + 2, y: lib.y + 1 } : this.home(a));
    const path = bfs(this.layout.grid, a.pos, dest);
    if (!path.length) return;
    this.walking.add(id);
    const prev = a.status;
    a.status = "walking"; a.activity = atHome ? "Walking to the library" : "Walking back to desk";
    this.emit({ type: "agent", agent: a });
    let i = 0;
    const step = () => {
      // ~8 tiles/s, batched like the server: one frame per 125 ms
      a.pos = path[i++];
      const done = i >= path.length;
      this.emit({ type: "agents.pos", positions: [{ id, x: a.pos.x, y: a.pos.y, status: done ? prev : "walking" }] });
      if (!done) { window.setTimeout(step, 125); return; }
      this.walking.delete(id);
      a.status = prev; a.activity = "";
      this.emit({ type: "agent", agent: a });
      if (atHome && !to) this.event("agent.said", id, "Moss: checking the library for duplicates before I review.", { text: "Checking the library for duplicates before I review." }, "bl_townhall");
      then?.();
    };
    step();
  }

  // ---------- actions ----------
  startWork(agentId: string, title?: string, description?: string, by = "us_mitchell"): Assignment {
    const a = this.agents.get(agentId)!;
    let asg = [...this.assignments.values()].find((x) => x.agentId === agentId && x.status === "pending");
    if (!asg || title) {
      asg = this.putAssignment({
        id: newId("as"), agentId, buildingId: a.homeBuildingId ?? "bl_carbon", title: title || `Next question for ${a.title}`, description: description || a.direction,
        status: "pending", createdBy: by, createdByKind: "user", fromMeetingId: null, fromReportId: null, reportId: null, createdAt: now(), updatedAt: now(),
      });
      this.event("assignment.created", agentId, `Assignment for ${a.name}: ${asg.title}`, { assignmentId: asg.id });
    }
    asg.status = "active"; this.putAssignment(asg);
    this.patchAgent(agentId, { status: "working", currentAssignmentId: asg.id, activity: "Starting session", lastActiveAt: now() });
    this.event("session.started", agentId, `${a.name} started a work session`);
    this.sessionLeft.set(agentId, 6);
    return asg;
  }

  finishSession(a: Agent) {
    this.sessionLeft.delete(a.id);
    const asg = a.currentAssignmentId ? this.assignments.get(a.currentAssignmentId) : null;
    const title = `${a.name}: ${asg?.title ?? "Session report"}`;
    const doc = this.putDoc({
      id: newId("dc"), type: "report", state: "building", title, authorId: a.id, authorKind: "agent", buildingId: a.homeBuildingId,
      provenance: { sourceIds: ["dc_gcb_essd"], urls: [] }, tags: [], verdict: "continue", decision: "pending", assignmentId: asg?.id, tokens: 108_000, costUsd: 0.84,
      body: `# ${asg?.title ?? "Session report"}\n\n## What I did\nRead the [GCB 2025 ESSD](gcb-2025-essd.md) source and wrote notes.\n\n## Findings\n- A finding with units: 2.9 ± 0.4 GtC/yr.\n\n## What I need from you\nNothing needed.`,
      createdAt: now(), updatedAt: now(),
    });
    if (asg) { asg.status = "done"; asg.reportId = doc.id; this.putAssignment(asg); }
    // hub semantics: the report goes to the manager's in-tray and the agent goes idle
    this.patchAgent(a.id, { status: "idle", activity: "", currentAssignmentId: null });
    this.event("doc.created", a.id, `${a.name} submitted a report: ${doc.title}`, { docId: doc.id });
    this.emitBuilding(doc.buildingId);
    this.event("session.ended", a.id, "Session ended (108k tokens, $0.84)");
  }

  /**
   * v1.2 decisions: approve = acknowledge only; continue = assignment from the report's Proposal; redirect = assignment
   * from the note (proposal appended); stop = agent stopped, its pending assignments cancelled.
   */
  review(docId: string, decision: "approve" | "continue" | "redirect" | "stop", note: string) {
    const d = this.docs.get(docId)!;
    if (decision === "redirect" && !note.trim()) throw new Error("Redirect needs a note.");
    Object.assign(d, { decision, decisionNote: note || undefined, decidedBy: "us_mitchell", decidedAt: now() });
    this.putDoc(d);
    const who = this.agents.get(d.authorId)?.name ?? "";
    const verb = { approve: "acknowledged", continue: "continued", redirect: "redirected", stop: "stopped" }[decision];
    this.event("doc.decision", d.authorId, `Mitchell ${verb} ${who}'s report`, { docId, decision }, d.buildingId);
    this.emitBuilding(d.buildingId);
    const a = this.agents.get(d.authorId);
    if (!a || decision === "approve") return d;
    if (decision === "stop") {
      for (const x of this.assignments.values()) if (x.agentId === a.id && x.status === "pending") { x.status = "cancelled"; this.putAssignment(x); }
      this.patchAgent(a.id, { status: "stopped", activity: "" });
      return d;
    }
    const proposal = /## Proposal[^\n]*\n+([^\n]+)/.exec(d.body)?.[1]?.trim() ?? "Follow up on this report";
    const title = decision === "continue" ? proposal : note.split("\n")[0];
    const description = decision === "continue" ? (note ? `${proposal}\n\nNote: ${note}` : proposal) : `${note}\n\nThe report proposed: ${proposal}`;
    const asg = this.putAssignment({
      id: newId("as"), agentId: a.id, buildingId: a.homeBuildingId ?? "bl_carbon", title: title.slice(0, 90), description,
      status: "pending", createdBy: "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: d.id, reportId: null, createdAt: now(), updatedAt: now(),
    });
    this.event("assignment.created", a.id, `Assignment for ${a.name}: ${asg.title}`, { assignmentId: asg.id }, a.homeBuildingId);
    // the scheduler starts a given assignment on an idle agent
    window.setTimeout(() => { if (this.agents.get(a.id)?.status === "idle") this.startWork(a.id); }, 2500);
    return d;
  }

  /**
   * Reports as replies: the reply is appended as a dated section, the author gets a mention and a `Reply on: …`
   * assignment (merge replies prefixed with the merge instruction). Empty text = archive.
   */
  reply(docId: string, raw: string): { doc: Doc; assignment: Assignment | null } {
    const d = this.docs.get(docId)!;
    const text = raw.trim();
    if (!text && d.decision && d.decision !== "pending") return { doc: d, assignment: null };
    const t = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
    Object.assign(d, {
      body: text ? `${d.body.replace(/\s+$/, "")}\n\n## Reply from Mitchell (${stamp})\n\n${text}\n` : d.body,
      decision: "approve", decisionNote: text || undefined, decidedBy: "us_mitchell", decidedAt: now(),
    });
    this.putDoc(d);
    const a = this.agents.get(d.authorId);
    this.event("doc.decision", d.authorId, text ? `Mitchell replied to "${d.title}": ${text.slice(0, 80)}` : `Archived: "${d.title}"`, { docId, decision: "approve", reply: !!text }, d.buildingId);
    this.emitBuilding(d.buildingId);
    if (!text || !a) return { doc: d, assignment: null };
    this.event("agent.mentioned", a.id, `Mitchell replied to your report "${d.title}": ${text.slice(0, 200)}`, { docId }, d.buildingId);
    if (a.status === "retired" || a.status === "banned") return { doc: d, assignment: null };
    const merge = /^merge\b/i.test(text) ? "Merge your pull request for this report (gh pr ready <n> && gh pr merge <n> --squash --delete-branch), confirm the merge, and report back with \"Nothing needed\" unless something failed.\n\n" : "";
    const asg = this.putAssignment({
      id: newId("as"), agentId: a.id, buildingId: a.homeBuildingId ?? "bl_carbon", title: `Reply on: ${d.title}`.slice(0, 120),
      description: `${merge}Mitchell's reply: ${text}\n\nThe report: ${d.title} (doc ${d.id}). Read it with \`read\`, do what the reply asks, and finish with a report whose last section says what you need next or "Nothing needed".`,
      status: "pending", createdBy: "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: d.id, reportId: null, createdAt: now(), updatedAt: now(),
    });
    this.event("assignment.created", a.id, `Assignment for ${a.name}: ${asg.title}`, { assignmentId: asg.id }, a.homeBuildingId);
    if (a.status === "stopped") this.patchAgent(a.id, { status: "idle" });
    window.setTimeout(() => { if (this.agents.get(a.id)?.status === "idle") this.startWork(a.id); }, 2500);
    return { doc: d, assignment: asg };
  }

  /** DELETE /api/agents/:id — retire: free the desk, cancel assignments, drop memberships; the row stays. */
  dismiss(agentId: string, purge: boolean) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("agent not found");
    if (a.status === "retired") throw new Error(`${a.name} was already dismissed.`);
    for (const x of this.assignments.values()) if (x.agentId === a.id && (x.status === "pending" || x.status === "active")) { x.status = "cancelled"; this.putAssignment(x); }
    this.memberships = this.memberships.filter((m) => !(m.holderKind === "agent" && m.holderId === a.id));
    this.sessionLeft.delete(a.id);
    this.patchAgent(a.id, { status: "retired", activity: "", currentAssignmentId: null, currentMeetingId: null });
    this.layout = computeLayout(this.buildings, [...this.agents.values()]);
    this.event("agent.retired", a.id, `${a.name} was dismissed by Mitchell${purge ? " (desk volume deleted)" : ""}`, { purge }, a.homeBuildingId);
    return a;
  }

  /** POST /api/agents/:id/ban (town.ban). */
  ban(agentId: string, reason: string) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("agent not found");
    this.sessionLeft.delete(a.id);
    this.patchAgent(a.id, { status: "banned", activity: "" });
    this.event("agent.banned", a.id, `Mitchell banned ${a.name}: ${reason}`, { reason }, a.homeBuildingId);
    return a;
  }

  createBuilding(name: string, goal = "", headcount = 6, reviewPolicy: Building["reviewPolicy"] = "human"): Building {
    const b: Building = { ...clone(F.buildings[1]), id: newId("bl"), name, goal, description: "", headcount, reviewPolicy, meetings: [], rules: "", workspace: null, lot: undefined, createdAt: now(), createdBy: "us_mitchell" };
    this.buildings.push(b);
    for (const r of ["manager", "reviewer", "member"] as const)
      this.roles.push({ id: `rl_${b.id}_${r}`, name: r, scope: "building", buildingId: b.id, permissions: [...BUILTIN_ROLES.building[r]], builtin: true });
    this.memberships.push({ roleId: `rl_${b.id}_manager`, holderKind: "user", holderId: "us_mitchell" });
    this.emit({ type: "building", building: { ...b, intray: 0 } });
    this.relayout();
    this.event("building.created", null, `Mitchell created ${name}`, {}, b.id);
    return b;
  }

  createResident(buildingId: string, name: string, title: string, direction: string, sprite?: number): Agent {
    const a: Agent = { ...clone(this.agents.get("ag_mei")!), id: newId("ag"), name, title, direction, sprite: sprite ?? Math.floor(Math.random() * 12), buildingId, homeBuildingId: buildingId, status: "idle", activity: "", spentTokensToday: 0, spentTokensTotal: 0, spentUsdTotal: 0, createdAt: now() };
    this.agents.set(a.id, a);
    this.memberships.push({ roleId: `rl_${buildingId === "bl_carbon" ? "carbon" : buildingId}_member`, holderKind: "agent", holderId: a.id });
    this.relayout(false);
    this.layout = computeLayout(this.buildings, [...this.agents.values()]);
    a.pos = this.home(a);
    this.emit({ type: "agent", agent: a });
    this.event("agent.created", a.id, `${name} moved into a desk`, {}, buildingId);
    return a;
  }
}
