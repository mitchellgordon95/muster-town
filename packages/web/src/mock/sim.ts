/** In-memory town for VITE_MOCK=1: holds state, animates it, and implements actions locally. */
import type { Agent, Allocation, Assignment, Building, CreateKeyResultInput, CreateObjectiveInput, Objective, UpdateObjectiveInput, DecideGrantInput, CloseGrantInput, Doc, Event, GrantView, KeyResult, Meeting, Membership, Role, ServerMessage, Stoplight, UpdateKeyResultInput } from "@muster-town/schema";
import { BUILTIN_ROLES, stoplightOf } from "@muster-town/schema";
import type { ForkSummary, GoalKeyResult, ObjectiveTree, ReportChain, Snapshot } from "../api";
import * as F from "./fixture";
import { bfs, computeLayout, type Layout } from "./layout";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();
/** core's BLOCKED_NO_KRS */
const BLOCKED_NO_KRS = "blocked: no key results to work toward";
let seq = 0;
export const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;
/** an allocation's spend by kind (the mock books it all as cache reads); spentTokens is their sum */
/** An allocation's spend of `n` adjusted output tokens, with the back-fill split of the 30 raw (Opus) behind each. */
export const spent = (n: number) => {
  const output = Math.round(n * 30 * (1 / 30 - 0.01) / 0.99);
  return { spentInput: 0, spentOutput: output, spentCacheRead: n * 30 - output, spentCacheWrite5m: 0, spentCacheWrite1h: 0, spentRawTokens: n * 30, spentTokens: n };
};

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
  grants = new Map<string, GrantView>(clone(F.grants).map((g) => [g.id, g]));
  keyResults = new Map<string, KeyResult>(clone(F.keyResults).map((k) => [k.id, k]));
  objectives = new Map<string, Objective>(clone(F.objectives).map((o) => [o.id, o]));
  events: Event[] = clone(F.events);
  roles: Role[] = clone(F.roles);
  memberships: Membership[] = clone(F.memberships);
  users = clone(F.users);
  allocations: Allocation[] = [
    { id: "al_house", userId: "us_mitchell", buildingId: "bl_carbon", tokens: 50_000_000, ...spent(3_320_000), spentUsd: 26.5, createdAt: F.ago(9000), auth: "api-key", label: "House budget (placeholder)", retired: true },
    { id: "al_sub", userId: "us_mitchell", buildingId: "bl_carbon", tokens: 40_000_000, ...spent(6_150_000), spentUsd: 0, createdAt: F.ago(600), auth: "subscription", label: "Mitchell's Claude subscription, October", retired: false },
    { id: "al_buffer", userId: "us_mitchell", buildingId: "bl_carbon", tokens: 10_000_000, ...spent(420_000), spentUsd: 3.1, createdAt: F.ago(590), auth: "api-key", label: "API-key buffer", retired: false },
  ];
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

  /** the runtime's last docker probe (the mock starts with docker down, so the HUD's red notice shows) */
  dockerUp = false;
  /** the host's session cap (desks.maxRunning) */
  maxRunning = 30;

  subscribe(fn: (m: ServerMessage) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(m: ServerMessage) { const c = clone(m); for (const s of this.subs) setTimeout(() => s(c), 0); }

  snapshot(): Snapshot {
    // Unlike the real server, the mock keeps retired agents in the snapshot so the client's filter is exercised.
    return clone({
      type: "snapshot", town: this.town, buildings: this.buildings.map((b) => ({ ...b, intray: this.intrayCount(b.id), budget: this.budgetOf(b.id), stoplight: this.stoplight(b.id) })),
      agents: [...this.agents.values()].filter((a) => a.status !== "banned"), places: this.layout.places, flags: [], grid: this.layout.grid,
      meetings: [...this.meetings.values()].filter((m) => m.phase !== "done" && m.phase !== "cancelled"),
      health: { docker: this.dockerUp, slots: { running: [...this.agents.values()].filter((a) => a.status === "working").length, max: this.maxRunning } },
      outbox: this.outboxOpen(),
    });
  }

  outboxOpen() { return [...this.docs.values()].filter((d) => d.type === "request" && d.requestStatus === "open").length; }

  /**
   * Pending reports for a building, oldest first (GET /api/buildings/:id/intray). As in core, a report by its
   * building's manager agent is a Town Hall item; the Town Hall's in-tray also has the grants awaiting a human.
   */
  intray(buildingId: string): { reports: Doc[]; chains: Record<string, ReportChain>; grants: GrantView[]; blocked: { buildingId: string; name: string; reason: string; since: string | null }[] } {
    const hall = this.buildings.find((b) => b.id === buildingId)?.kind === "town-hall";
    const managerOf = (id: string | null) => this.buildings.find((b) => b.id === id)?.managerAgentId;
    const reports = [...this.docs.values()].filter((d) => (d.type === "report" || d.type === "flag") && d.decision === "pending"
      && (hall ? d.type === "report" && !!d.buildingId && managerOf(d.buildingId) === d.authorId : d.buildingId === buildingId && managerOf(d.buildingId) !== d.authorId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const grants = hall ? [...this.grants.values()].filter((g) => g.status === "proposed" || g.status === "countered" || g.status === "checkpoint" || awaitingMark(g)) : [];
    const blocked = hall ? this.buildings.filter((b) => b.kind !== "town-hall").flatMap((b) => { const r = this.grantBoard(b.id).blocked; return r ? [{ buildingId: b.id, name: b.name, reason: r, since: b.blockedAt ?? null }] : []; }) : [];
    return { reports, chains: this.reportChains(reports), grants, blocked };
  }
  /** As core's reportChain: a report's chain, hop and previous hop's report. */
  reportChain(d: Doc): ReportChain | null {
    const a = d.assignmentId ? this.assignments.get(d.assignmentId) : undefined;
    if (!a) return null;
    const chainId = a.chainId ?? a.id;
    const chain = [...this.assignments.values()].filter((x) => x.id === chainId || x.chainId === chainId);
    const hop = chain.filter((x) => x.createdAt <= a.createdAt).length;
    const ids = new Set(chain.filter((x) => x.id !== a.id).map((x) => x.id));
    const prev = [...this.docs.values()].filter((x) => x.type === "report" && x.id !== d.id && x.assignmentId && ids.has(x.assignmentId) && x.createdAt <= d.createdAt)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return { chainId, hop: Math.max(1, hop), prevReportId: prev?.id ?? null, sessionId: d.sessionId ?? null, assignmentId: a.id, forkOf: this.agents.get(d.authorId)?.forkOf ?? null };
  }
  /** Chains of the fork-authored reports among `docs` (the in-tray's chain badges). */
  reportChains(docs: Doc[]): Record<string, ReportChain> {
    const out: Record<string, ReportChain> = {};
    for (const d of docs) { const c = this.agents.get(d.authorId)?.forkOf ? this.reportChain(d) : null; if (c) out[d.id] = c; }
    return out;
  }
  /** As core's forkSummary. */
  forkSummary(f: Agent): ForkSummary | null {
    if (!f.forkOf) return null;
    const report = [...this.docs.values()].filter((d) => d.type === "report" && d.authorId === f.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    const asg = this.assignments.get(f.currentAssignmentId ?? report?.assignmentId ?? "") ?? [...this.assignments.values()].find((a) => a.agentId === f.id);
    const chain = asg ? this.reportChain({ ...(report ?? { id: "", createdAt: asg.createdAt }), assignmentId: asg.id } as Doc) : null;
    return {
      agent: f, forkOfName: this.nameOf(f.forkOf) ?? f.forkOf, assignmentId: asg?.id ?? null, assignmentTitle: asg?.title ?? null, chainId: chain?.chainId ?? null, hop: chain?.hop ?? null,
      sessionId: report?.sessionId ?? (f.status === "working" ? `se_${f.id}` : null), tokens: report?.tokens ?? f.spentTokensToday, transcript: !!report?.sessionId,
      reportId: report?.id ?? null, reportTitle: report?.title ?? null,
      pagesEdited: [...this.docs.values()].filter((d) => d.topicOf && d.authorId === f.id).map((d) => ({ id: d.id, title: d.title })),
    };
  }
  forksOf(managerId: string) {
    const all = [...this.agents.values()].filter((a) => a.forkOf === managerId);
    const m = this.agents.get(managerId), b = this.buildings.find((x) => x.id === m?.homeBuildingId);
    return {
      live: all.filter((a) => a.status !== "retired").sort((x, y) => (x.forkN ?? 0) - (y.forkN ?? 0)).map((a) => this.forkSummary(a)!),
      retired: all.filter((a) => a.status === "retired").sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 50).map((a) => this.forkSummary(a)!),
      notStarted: 0,
      family: [m, ...all].reduce((f, a) => a ? { ...f, today: f.today + a.spentTokensToday, forksToday: f.forksToday + (a.forkOf ? a.spentTokensToday : 0), total: f.total + a.spentTokensTotal, usdTotal: f.usdTotal + a.spentUsdTotal } : f, { today: 0, forksToday: 0, cap: b ? b.dailyTokensPerAgent * b.headcount : 0, total: 0, usdTotal: 0, forks: all.length }),
    };
  }
  /** The budget part of GET /api/buildings/:id/board, as core's Grants.board (exploration spend is the fixture's). */
  grantBoard(buildingId: string) {
    const b = this.buildings.find((x) => x.id === buildingId);
    const of = (g: GrantView) => g.buildingId === buildingId;
    const grants = [...this.grants.values()].filter((g) => of(g) && (g.status === "funded" || g.status === "checkpoint")).sort((x, y) => (x.fundedAt ?? "").localeCompare(y.fundedAt ?? ""));
    const proposals = [...this.grants.values()].filter((g) => of(g) && (g.status === "proposed" || g.status === "countered")).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const keyResults = this.goalKeyResults(buildingId);
    const blocked = !!b && b.kind !== "town-hall" && !keyResults.length && !grants.length ? BLOCKED_NO_KRS : null;
    return { goal: b?.goal ?? "", keyResults, objectives: this.objectiveTree(buildingId), blocked, stoplight: this.stoplight(buildingId), grants, proposals, exploration: { allowanceTokens: b?.explorationTokensPerDay ?? 0, spentTodayTokens: F.explorationSpentToday[buildingId] ?? 0 } };
  }
  /** The building's stoplight, as core's Grants.stoplight: null for the Town Hall. */
  stoplight(buildingId: string): Stoplight | null {
    const b = this.buildings.find((x) => x.id === buildingId);
    if (!b || b.kind === "town-hall") return null;
    return stoplightOf(this.goalKeyResults(buildingId), [...this.grants.values()].filter((g) => g.buildingId === buildingId && (g.status === "funded" || g.status === "checkpoint")));
  }
  /** An agent's or user's name (core's World.nameOf), null for none. */
  private nameOf(id: string | null): string | null {
    if (!id) return null;
    return this.agents.get(id)?.name ?? (this.users as { id: string; name: string }[]).find((u) => u.id === id)?.name ?? id;
  }
  /** GET /api/buildings/:id/key-results: the goal's key results in order, each with the live grant naming it. */
  goalKeyResults(buildingId: string): GoalKeyResult[] {
    const live = new Map([...this.grants.values()].filter((g) => g.keyResultId && (g.status === "funded" || g.status === "checkpoint")).map((g) => [g.keyResultId!, g.id]));
    return [...this.keyResults.values()].filter((k) => k.buildingId === buildingId).sort((a, b) => a.position - b.position).map((k) => ({ ...k, grantId: live.get(k.id) ?? null, createdByName: this.nameOf(k.createdBy), editedByName: this.nameOf(k.editedBy) }));
  }
  /** GET /api/buildings/:id/objectives, as core's Grants.objectiveTree. */
  objectiveTree(buildingId: string): ObjectiveTree {
    const krs = this.goalKeyResults(buildingId);
    const objectives = [...this.objectives.values()].filter((o) => o.buildingId === buildingId).sort((a, b) => a.position - b.position).map((o) => {
      const k = F.kpis.find((x) => x.id === o.kpiId);
      return { ...o, kpi: k?.key ?? null, kpiName: k?.name ?? null, keyResults: krs.filter((x) => x.objectiveId === o.id), createdByName: this.nameOf(o.createdBy), editedByName: this.nameOf(o.editedBy) };
    });
    const ids = new Set(objectives.map((o) => o.id));
    return { objectives, unsorted: krs.filter((k) => !k.objectiveId || !ids.has(k.objectiveId)) };
  }
  createObjective(buildingId: string, i: CreateObjectiveInput): Objective {
    const mine = [...this.objectives.values()].filter((o) => o.buildingId === buildingId);
    if (mine.length >= 3) throw new Error("This goal already has 3 objectives (at most 3): edit one instead.");
    const o: Objective = { id: newId("ob"), buildingId, position: Math.max(-1, ...mine.map((x) => x.position)) + 1, text: i.text.trim(), horizon: i.horizon ?? "2026-Q4", kpiId: i.kpi ? `kpi_${i.kpi}` : null, createdBy: "us_mitchell", editedBy: null, sourceDocIds: i.sourceDocIds ?? [], updatedAt: now() };
    this.objectives.set(o.id, o);
    this.event("objective.created", null, `Objective: ${o.text}`, { objectiveId: o.id }, buildingId);
    return o;
  }
  updateObjective(id: string, i: UpdateObjectiveInput): Objective {
    const o = this.objectives.get(id);
    if (!o) throw new Error(`objective not found: ${id}`);
    const next: Objective = { ...o, ...(i.text !== undefined && { text: i.text.trim() }), ...(i.horizon !== undefined && { horizon: i.horizon }), ...(i.kpi !== undefined && { kpiId: i.kpi ? `kpi_${i.kpi}` : null }), editedBy: "us_mitchell", updatedAt: now() };
    this.objectives.set(id, next);
    return next;
  }
  deleteObjective(id: string): void {
    if ([...this.keyResults.values()].some((k) => k.objectiveId === id)) throw new Error("Key results hang off this objective: move them first.");
    this.objectives.delete(id);
  }
  /** POST /api/buildings/:id/key-results (only a human writes them; the mock's user is one). */
  createKeyResult(buildingId: string, i: CreateKeyResultInput): KeyResult {
    const b = this.buildings.find((x) => x.id === buildingId);
    if (!b) throw new Error(`building not found: ${buildingId}`);
    const last = Math.max(-1, ...this.goalKeyResults(buildingId).map((k) => k.position));
    const k: KeyResult = { id: newId("kr"), buildingId, position: last + 1, text: i.text.trim(), howToCheck: i.howToCheck.trim(), status: "not-started", statusNote: "", statusBy: null, createdBy: "us_mitchell", editedBy: null, sourceDocIds: i.sourceDocIds ?? [], objectiveId: i.objectiveId ?? null, updatedAt: now() };
    this.keyResults.set(k.id, k);
    this.event("kr.created", null, `${b.name} key result: ${k.text}`, { keyResultId: k.id }, buildingId);
    return k;
  }
  /** PATCH /api/key-results/:id: words and / or status (the mock skips the status permission split). */
  updateKeyResult(id: string, i: UpdateKeyResultInput): KeyResult {
    const k = this.keyResults.get(id);
    if (!k) throw new Error(`key result not found: ${id}`);
    const words = { ...(i.text !== undefined && { text: i.text.trim() }), ...(i.howToCheck !== undefined && { howToCheck: i.howToCheck.trim() }), ...(i.sourceDocIds !== undefined && { sourceDocIds: i.sourceDocIds }) };
    const moved = i.objectiveId !== undefined && i.objectiveId !== k.objectiveId;
    if (!i.status && !Object.keys(words).length && !moved) throw new Error("Nothing to change: give status, text, howToCheck or objectiveId.");
    if (moved && i.objectiveId && [...this.keyResults.values()].filter((x) => x.objectiveId === i.objectiveId).length >= 4) throw new Error("That objective already has 4 key results (at most 4).");
    const next: KeyResult = { ...k, ...words, ...(moved && { objectiveId: i.objectiveId ?? null }), ...(Object.keys(words).length && { editedBy: "us_mitchell" }), ...(i.status ? { status: i.status, statusNote: i.note ?? "", statusBy: "us_mitchell" } : {}), updatedAt: now() };
    this.keyResults.set(id, next);
    for (const g of this.grants.values()) if (g.keyResultId === id) g.keyResult = { ...next };
    this.event("kr.updated", null, i.status ? `Key result ${i.status}: ${next.text}` : `Key result edited: ${next.text}`, { keyResultId: id, status: next.status, from: k.status }, k.buildingId);
    return next;
  }
  /** DELETE /api/key-results/:id: refused while a draft, open or live grant names it (core's 409). */
  deleteKeyResult(id: string): void {
    const k = this.keyResults.get(id);
    if (!k) throw new Error(`key result not found: ${id}`);
    const g = [...this.grants.values()].find((x) => x.keyResultId === id && ["draft", "proposed", "countered", "funded", "checkpoint"].includes(x.status));
    if (g) throw new Error(`Grant ${g.id} ("${g.objective}", ${g.status}) names this key result: close or re-point it first.`);
    this.keyResults.delete(id);
    this.event("kr.deleted", null, `Key result removed: ${k.text}`, { keyResultId: id }, k.buildingId);
  }
  intrayCount(buildingId: string) { const t = this.intray(buildingId); return t.reports.length + t.grants.length; }

  /** POST /api/grants/:id/decide, as core's Grants.decide (no ledger: spend is the fixture's). */
  decideGrant(id: string, i: DecideGrantInput): GrantView {
    const g = this.grants.get(id);
    if (!g) throw new Error("grant not found");
    const want = { fund: "proposed", counter: "proposed", reject: "proposed", continue: "checkpoint", adjust: "checkpoint", cut: "checkpoint" }[i.action];
    if (g.status !== want) throw new Error(`The grant is ${g.status}; it can't be ${i.action === "fund" ? "funded" : i.action === "cut" ? "cut" : `${i.action}ed`}.`);
    const note = i.note ?? "";
    if (i.action === "counter" && !note.trim()) throw new Error("A counter needs a note saying what to change.");
    const tokens = i.action === "fund" ? i.tokens ?? g.askTokens : i.action === "adjust" ? i.tokens ?? g.grantTokens ?? 0 : i.tokens ?? null;
    if (i.action === "adjust" && (tokens ?? 0) <= g.spentTokens) throw new Error("An adjusted grant must be more than it has spent.");
    const status = { fund: "funded", counter: "countered", reject: "rejected", continue: "funded", adjust: "funded", cut: "closed" }[i.action] as GrantView["status"];
    Object.assign(g, {
      status, updatedAt: now(),
      ...(i.action === "fund" || i.action === "adjust" ? { grantTokens: tokens } : {}),
      ...(i.action === "fund" ? { fundedBy: "us_mitchell", fundedByName: "Mitchell", fundedWith: i.fundWith ?? null, fundedWithLabel: i.fundWith ? "Mitchell's API key" : null, fundedAt: now() } : {}),
      ...(i.action === "counter" && tokens ? { askTokens: tokens } : {}),
      ...(i.action === "cut" ? { outcome: "cut", closedAt: now() } : i.action === "reject" ? { closedAt: now() } : {}),
    });
    g.history.push({ at: now(), byId: "us_mitchell", byKind: "user", action: i.action, tokens: tokens, note });
    const b = this.buildings.find((x) => x.id === g.buildingId);
    this.event(`grant.${status === "closed" ? "closed" : status}` as Event["type"], null, `Mitchell ${i.action === "cut" ? "cut" : `${i.action}ed`} ${b?.name ?? ""}'s ${g.objective}`, { grantId: g.id }, g.buildingId);
    this.emitBuilding(this.buildings.find((x) => x.kind === "town-hall")?.id ?? null);
    return g;
  }
  /** POST /api/grants/:id/close, as core's Grants.close (outcome "done": closeDone, the key result to claimed). */
  closeGrant(id: string, i: CloseGrantInput): GrantView {
    const g = this.grants.get(id);
    if (!g) throw new Error("grant not found");
    if (g.status !== "funded" && g.status !== "checkpoint") throw new Error(`This grant is ${g.status}.`);
    const note = i.note ?? "";
    const unspent = Math.max(0, (g.grantTokens ?? 0) - g.spentTokens);
    Object.assign(g, { status: "closed", outcome: i.outcome, closedAt: now(), updatedAt: now() });
    g.history.push({ at: now(), byId: "us_mitchell", byKind: "user", action: "close", tokens: i.outcome === "done" ? unspent : null, note });
    if (i.outcome === "done" && g.keyResultId) this.updateKeyResult(g.keyResultId, { status: "claimed", note });
    this.event("grant.closed", null, `Closed (${i.outcome}): ${g.objective}`, { grantId: g.id }, g.buildingId);
    this.emitBuilding(this.buildings.find((x) => x.kind === "town-hall")?.id ?? null);
    return g;
  }
  budgetOf(buildingId: string) {
    const al = this.allocations.filter((a) => a.buildingId === buildingId && !a.retired);
    const allocatedTokens = al.reduce((s, a) => s + a.tokens, 0), spentTokens = al.reduce((s, a) => s + a.spentTokens, 0);
    return { allocatedTokens, spentTokens, remainingTokens: Math.max(0, allocatedTokens - spentTokens), bankTokens: 0, tokensToday: spentTokens, tokensAllTime: spentTokens };
  }
  /** Resend a building with its in-tray count (the server does this when reports are created or decided). */
  emitBuilding(buildingId: string | null) {
    const b = this.buildings.find((x) => x.id === buildingId);
    if (b) this.emit({ type: "building", building: { ...b, intray: this.intrayCount(b.id), budget: this.budgetOf(b.id), stoplight: this.stoplight(b.id) } });
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
    return { ...(at(`desk:${a.id}`) ?? (a.kind === "visitor" ? at("visitor-bench") : undefined) ?? at(`door:${a.homeBuildingId}`) ?? { x: 2, y: 2 }) };
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
      const order = { subscription: 0, "donor-key": 1, "api-key": 2 } as const;
      const al = this.allocations.filter((x) => x.buildingId === a.homeBuildingId && !x.retired && x.spentTokens < x.tokens).sort((x, y) => order[x.auth] - order[y.auth])[0];
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
  /** A new pending assignment at the back of the queue (or the front). */
  newAssignment(agentId: string, f: { title: string; description: string; fromReportId?: string | null; fromAssignmentId?: string | null; front?: boolean; by?: string }): Assignment {
    const a = this.agents.get(agentId)!;
    const q = this.queue(agentId);
    const asg = this.putAssignment({
      id: newId("as"), agentId, buildingId: a.homeBuildingId ?? "bl_carbon", title: f.title, description: f.description,
      status: "pending", createdBy: f.by ?? "us_mitchell", createdByKind: "user", fromMeetingId: null, fromReportId: f.fromReportId ?? null, reportId: null,
      fromAssignmentId: f.fromAssignmentId ?? null, lane: "directed", grantId: null, keyResultId: null, gap: null, sourceId: null, heldReason: null, origin: null, chainId: null, queue: "agent", model: null, position: f.front && q.length ? q[0].position - 1 : Date.now(), createdAt: now(), updatedAt: now(),
    });
    this.event("assignment.created", agentId, `Assignment for ${a.name}: ${asg.title}`, { assignmentId: asg.id }, a.homeBuildingId);
    return asg;
  }
  /** Pending assignments in run order (position, then createdAt), like the server's scheduler. */
  queue(agentId: string): Assignment[] {
    return [...this.assignments.values()].filter((x) => x.agentId === agentId && x.status === "pending")
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }
  /** The scheduler: an idle agent with a queue starts its first assignment. */
  runNext(agentId: string): Assignment | null {
    const a = this.agents.get(agentId);
    const asg = this.queue(agentId)[0];
    if (!a || a.status !== "idle" || !asg) return null;
    asg.status = "active"; this.putAssignment(asg);
    this.patchAgent(agentId, { status: "working", currentAssignmentId: asg.id, activity: "Starting session", lastActiveAt: now() });
    this.event("session.started", agentId, `${a.name} started a work session`);
    this.sessionLeft.set(agentId, 6);
    return asg;
  }
  startWork(agentId: string, title?: string, description?: string, by = "us_mitchell"): Assignment {
    const a = this.agents.get(agentId)!;
    const created = title || !this.queue(agentId).length
      ? this.newAssignment(agentId, { title: title || `Next question for ${a.title}`, description: description || a.direction, front: !!title, by })
      : null;
    return this.runNext(agentId) ?? created ?? this.queue(agentId)[0];
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
    window.setTimeout(() => this.runNext(a.id), 2500);
  }

  /**
   * v1.2 decisions: approve = acknowledge only; continue = assignment from the report's Proposal; redirect = assignment
   * from the note (proposal appended); stop = agent stopped, its pending assignments cancelled.
   */
  /** A human's flag: a pending `flag` doc in the building's in-tray (POST /api/buildings/:id/flags). */
  plantFlag(buildingId: string, text: string): Doc {
    const body = text.trim();
    if (!body) throw new Error("A flag needs a note: what you want done.");
    const title = body.split("\n")[0].slice(0, 120);
    const d: Doc = { id: newId("dc"), type: "flag", state: "building", title, body, decision: "pending", authorId: "us_mitchell", authorKind: "user", buildingId, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: now(), updatedAt: now() };
    this.putDoc(d);
    this.event("doc.created", null, `Mitchell planted a flag: ${title}`, { docId: d.id, docType: "flag" }, buildingId);
    this.emitBuilding(buildingId);
    return d;
  }
  /** As core's decideFlag: approve = handled; continue/redirect = a directed assignment for a resident of the flag's building. */
  private decideFlag(d: Doc, decision: "approve" | "continue" | "redirect" | "stop", note: string, assigneeId?: string): Doc {
    if (decision === "stop") throw new Error("A flag has no agent to stop.");
    const a = decision === "approve" ? undefined : this.agents.get(assigneeId ?? "");
    if (decision !== "approve" && (!a || (a.homeBuildingId ?? a.buildingId) !== d.buildingId)) throw new Error("Pick a resident of the building to take the flag.");
    Object.assign(d, { decision, decisionNote: note || undefined, decidedBy: "us_mitchell", decidedAt: now() });
    this.putDoc(d);
    this.event("doc.decision", a?.id ?? null, `Mitchell ${decision === "approve" ? "handled" : "delegated"} the flag "${d.title}"${a ? ` → ${a.name}` : ""}`, { docId: d.id, decision }, d.buildingId);
    this.emitBuilding(d.buildingId);
    if (!a) return d;
    const title = decision === "continue" ? d.title : note.split("\n")[0].slice(0, 120);
    this.newAssignment(a.id, { title: title.slice(0, 90), description: decision === "continue" ? `Mitchell planted a flag in your building (${d.id}):\n\n${d.body}` : `${note}\n\nThe flag said:\n\n${d.body}`, fromReportId: d.id });
    window.setTimeout(() => this.runNext(a.id), 2500);
    return d;
  }
  review(docId: string, decision: "approve" | "continue" | "redirect" | "stop", note: string, assigneeId?: string) {
    const d = this.docs.get(docId)!;
    if (decision === "redirect" && !note.trim()) throw new Error("Redirect needs a note.");
    if (d.type === "flag") return this.decideFlag(d, decision, note.trim(), assigneeId);
    Object.assign(d, { decision, decisionNote: note || undefined, decidedBy: "us_mitchell", decidedAt: now() });
    this.putDoc(d);
    const who = this.agents.get(d.authorId)?.name ?? "";
    const verb = { approve: "acknowledged", continue: "continued", redirect: "redirected", stop: "stopped" }[decision];
    this.event("doc.decision", d.authorId, `Mitchell ${verb} ${who}'s report`, { docId, decision }, d.buildingId);
    this.emitBuilding(d.buildingId);
    this.emitBuilding(this.buildings.find((x) => x.kind === "town-hall")?.id ?? null);
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
    this.newAssignment(a.id, { title: title.slice(0, 90), description, fromReportId: d.id });
    // the scheduler starts a given assignment on an idle agent
    window.setTimeout(() => this.runNext(a.id), 2500);
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
    const asg = this.newAssignment(a.id, {
      title: `Reply on: ${d.title}`.slice(0, 120), fromReportId: d.id,
      description: `${merge}Mitchell's reply: ${text}\n\nThe report: ${d.title} (doc ${d.id}). Read it with \`read\`, do what the reply asks, and finish with a report whose last section says what you need next or "Nothing needed".`,
    });
    if (a.status === "stopped") this.patchAgent(a.id, { status: "idle" });
    window.setTimeout(() => this.runNext(a.id), 2500);
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

  createBuilding(name: string, goal = "", headcount = 6): Building {
    const b: Building = { ...clone(F.buildings[1]), id: newId("bl"), name, goal, description: "", headcount, meetings: [], rules: "", codeAccess: !!F.town.workspace, lot: undefined, createdAt: now(), createdBy: "us_mitchell" };
    this.buildings.push(b);
    for (const r of ["manager", "reviewer", "member"] as const)
      this.roles.push({ id: `rl_${b.id}_${r}`, name: r, scope: "building", buildingId: b.id, permissions: [...BUILTIN_ROLES.building[r]], builtin: true });
    this.memberships.push({ roleId: `rl_${b.id}_manager`, holderKind: "user", holderId: "us_mitchell" });
    this.emit({ type: "building", building: { ...b, intray: 0 } });
    this.relayout();
    this.event("building.created", null, `Mitchell created ${name}`, {}, b.id);
    return b;
  }

  /** a signed-in person's own agent (POST /api/agents/visitors): a visitor on the plaza, or at a desk in buildingId */
  createVisitor(name: string, buildingId?: string): Agent {
    const a: Agent = { ...clone(this.agents.get("ag_mei")!), id: newId("ag"), kind: "visitor", name, title: "Visitor", direction: "", sprite: Math.floor(Math.random() * 12), buildingId: buildingId ?? null, homeBuildingId: buildingId ?? null, ownerUserId: this.users[0]?.id ?? null, status: "idle", activity: "", spentTokensToday: 0, spentTokensTotal: 0, spentUsdTotal: 0, createdAt: now() };
    this.agents.set(a.id, a);
    this.layout = computeLayout(this.buildings, [...this.agents.values()]);
    a.pos = this.home(a);
    this.emit({ type: "agent", agent: a });
    this.event("agent.created", a.id, `${name} arrived as a visitor`, {}, buildingId ?? null);
    return a;
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

/** Closed early as done by the manager (close_grant) and its key result still claimed: a human marks it met or missed. */
export function awaitingMark(g: GrantView): boolean {
  return g.status === "closed" && g.outcome === "done" && g.keyResult?.status === "claimed";
}
