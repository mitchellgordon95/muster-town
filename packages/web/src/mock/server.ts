/** `Api` implemented against the in-memory Sim. Same interface as HttpApi, so every panel works offline. */
import type { AccessRequest, AccessRequestView, CaptainRequest, CaptainRequestView, Agent, Assignment, AssignmentCard, AuthMe, BlockedAssignment, BlockedBy, BuildingStats, Schedule, Building, Doc, Event, Meeting, Membership, MapLayout, RedeployLive, ReviewDeck, ReviewSlide } from "@muster-town/schema";
import { BuildingDefaults, NEW_LAB_LOT, REVIEW_DECK_ID, desksForLot, funderSlide, parseDeck } from "@muster-town/schema";
import { BACKFILL, BOARD_TYPES, KPI_FRAMING, ZERO_TOKENS, addTokens, backfillFamily, splitRaw, type FreeTokens, type GoalTreeNode, type GoalSpend, type QueueBoard, type FunderWeek } from "@muster-town/schema";
import type { Api, AgentDetail, AllocationRow, Bank, Budget, Finance, FinanceFly, FinanceSources, FinanceSpend, Cabinet, CabinetQuery, DocQuery, EventQuery, In, LayoutPreview, FunderWeekView, JoinFunnelView, RoomLayout, RequestAction, SessionDetail, Snapshot, Socket, SocketHandlers, ThreadMessage, WriteDocInput } from "../api";
import { ApiError } from "../api";
import type { BankStreams, PinSkillInput, PutSecretInput, SecretView, SkillPinView, SkillView } from "@muster-town/schema";
import type { CreateBuildingInput, UpdateBuildingInput, RegisterVisitorInput, ReviewInput, WorkInput, DonateInput, CreateMeetingInput, DocState, AddBankInput, BankInput, DecideGrantInput, CloseGrantInput, UpdateKeyResultInput, CreateObjectiveInput, UpdateObjectiveInput } from "@muster-town/schema";
import { Sim, newId, spent } from "./sim";
import { explorationSpentToday, kpis as kpisFixture, memoryDocs } from "./fixture";
import manualMd from "../../../../docs/manual.md?raw";

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** the mock tree's exploration caps set on a goal (tokens/day), inherited one level down; the root's is town-wide */
const MOCK_CAP: Record<string, number> = { gl_town: 3_000_000 };
const F_SPENT_TODAY = () => Object.values(explorationSpentToday).reduce((s, n) => s + n, 0);

export class MockApi implements Api {
  readonly mock = true;
  private sim = new Sim();
  /** two schedules on the Carbon Cycle Lab, one paused (the building panel's Schedule list, the marks on its schedule board) */
  private schedules = new Map<string, Schedule>([["sc_nightly", {
    id: "sc_nightly", buildingId: "bl_carbon", title: "Nightly: check the live rollup", description: "Read the latest rollup and check its numbers against the live town.",
    nextRunAt: new Date(Date.now() + 3 * 3600_000).toISOString(), everyMinutes: null, dailyAt: ["08:00", "20:00"], endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), maxRuns: null, paused: false,
    lane: "exploration", grantId: null, keyResultId: null, gap: "rollup numbers drift from the live town", sourceId: null, pages: [], model: null, origin: null,
    status: "active", endedReason: null, lastRunAt: null, lastAssignmentId: null, runs: 2, createdBy: "ag_moss", createdByKind: "agent",
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), updatedAt: new Date().toISOString(),
  }], ["sc_weekly", {
    id: "sc_weekly", buildingId: "bl_carbon", title: "Every 6 h: refresh the emissions source cards", description: "Re-check the Global Carbon Budget source cards for new releases.",
    nextRunAt: new Date(Date.now() + 5 * 3600_000).toISOString(), everyMinutes: 360, dailyAt: null, endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(), maxRuns: null, paused: true,
    lane: "exploration", grantId: null, keyResultId: null, gap: "source cards go stale", sourceId: null, pages: [], model: null, origin: null,
    status: "active", endedReason: null, lastRunAt: null, lastAssignmentId: null, runs: 0, createdBy: "ag_moss", createdByKind: "agent",
    createdAt: new Date(Date.now() - 86400_000).toISOString(), updatedAt: new Date().toISOString(),
  }]]);
  private started = false;
  private prevStatus = new Map<string, Agent["status"]>();
  /** v1.4: unread messages per visitor (the fixture visitor starts with two) */
  private unread = new Map<string, number>([["ag_visitor", 2]]);

  private need<T>(x: T | undefined, what: string): T {
    if (x === undefined || x === null) throw new ApiError(`${what} not found`, "not_found", 404);
    return x;
  }

  /** who may interact (dc_f0cumcfubk): one stranger already waiting in the Town Hall in-tray; `?as=visitor` can ask too */
  private access: AccessRequestView[] = [{ id: "ar_octo", userId: "us_octo", message: "I'd like to help with the onboarding copy", status: "pending", decidedBy: null, createdAt: new Date(Date.now() - 40 * 60_000).toISOString(), decidedAt: null, name: "Octo Cat", githubLogin: "octocat", avatarUrl: null }];

  /** "Ask to captain this goal" (gr_bwm0iz7rwl): Octo already asks to captain Trust */
  private captains: CaptainRequestView[] = [{ id: "cr_octo", goalId: "gl_trust", userId: "us_octo", note: "I review finance pages for a living", status: "pending", decidedBy: null, decisionNote: "", createdAt: new Date(Date.now() - 25 * 60_000).toISOString(), decidedAt: null, name: "Octo Cat", githubLogin: "octocat", avatarUrl: null, goalText: "Trust", captainId: null, captainName: "the town admins" }];
  async askToCaptain(goalId: string, note = ""): Promise<CaptainRequest> {
    await wait(120);
    if (this.captains.some((r) => r.goalId === goalId && r.userId === "us_guest" && r.status === "pending")) throw new ApiError("You already asked to captain this goal; it is waiting for a decision.", "conflict", 409);
    const r: CaptainRequestView = { id: `cr_${Date.now().toString(36)}`, goalId, userId: "us_guest", note: note.trim().slice(0, 280), status: "pending", decidedBy: null, decisionNote: "", createdAt: new Date().toISOString(), decidedAt: null, name: "Guest", githubLogin: "guest", avatarUrl: null, goalText: goalId, captainId: null, captainName: "the town admins" };
    this.captains.push(r);
    return clone(r);
  }
  async captainRequests(goalId: string) { await wait(); return clone(this.captains.filter((r) => r.goalId === goalId && r.status === "pending")); }
  async decideCaptain(id: string, action: "accept" | "decline", note = ""): Promise<CaptainRequest> {
    await wait(120);
    const r = this.need(this.captains.find((x) => x.id === id), "captain request");
    if (r.status !== "pending") throw new ApiError(`This request was already ${r.status}.`, "conflict", 409);
    Object.assign(r, { status: action === "accept" ? "accepted" : "declined", decidedBy: "us_mitchell", decisionNote: note, decidedAt: new Date().toISOString() });
    return clone(r);
  }

  async devAdminToken() { return "mock-admin-token"; }
  async requestAccess(message: string): Promise<AccessRequest> {
    await wait(120);
    const mine = this.access.find((r) => r.userId === "us_guest" && r.status === "pending");
    if (mine) return clone(mine);
    const r: AccessRequestView = { id: `ar_${Date.now().toString(36)}`, userId: "us_guest", message: message.trim().slice(0, 140), status: "pending", decidedBy: null, createdAt: new Date().toISOString(), decidedAt: null, name: "Guest", githubLogin: "guest", avatarUrl: null };
    this.access.push(r);
    return clone(r);
  }
  async decideAccess(id: string, grant: boolean): Promise<AccessRequest> {
    await wait(120);
    const r = this.need(this.access.find((x) => x.id === id), "access request");
    if (r.status !== "pending") throw new ApiError(`This request was already ${r.status}.`, "conflict", 409);
    Object.assign(r, { status: grant ? "granted" : "declined", decidedBy: "us_mitchell", decidedAt: new Date().toISOString() });
    return clone(r);
  }
  async accessRequests(): Promise<AccessRequestView[]> {
    await wait(60);
    return clone(this.access.filter((r) => r.status === "pending"));
  }
  async me(): Promise<AuthMe> {
    await wait(60);
    // `?as=visitor` signs in as a plain visitor so read-only views can be checked; `?as=member` as a let-in member (Ask to captain)
    const as = new URLSearchParams(location.search).get("as");
    if (as === "member") return clone({ user: { ...this.sim.users[0], id: "us_guest", name: "Guest", githubLogin: "guest" }, roles: [], avatarAgentId: "ag_me", isAdmin: false, canInteract: true, accessRequest: null });
    if (as === "visitor") {
      const mine = [...this.access].reverse().find((r) => r.userId === "us_guest");
      return clone({ user: { ...this.sim.users[0], id: "us_guest", name: "Guest", githubLogin: "guest" }, roles: this.sim.roles.filter((r) => r.id === "rl_visitor"), avatarAgentId: "ag_me", isAdmin: false,
        canInteract: mine?.status === "granted", accessRequest: mine ? { status: mine.status, message: mine.message, decidedAt: mine.decidedAt, deciders: [this.sim.users[0].name], typicalWaitMs: null } : null });
    }
    const roleIds = new Set(this.sim.memberships.filter((m) => m.holderKind === "user" && m.holderId === "us_mitchell").map((m) => m.roleId));
    return clone({ user: this.sim.users[0], roles: this.sim.roles.filter((r) => roleIds.has(r.id)), avatarAgentId: "ag_me", isAdmin: true, canInteract: true, accessRequest: null });
  }
  async town(): Promise<Snapshot> { await wait(); return this.sim.snapshot(); }
  async events(q: EventQuery): Promise<Event[]> {
    await wait(80);
    let ev = this.sim.events.filter((e) => (q.since === undefined || e.id > q.since) && (!q.agentId || e.agentId === q.agentId) && (!q.buildingId || e.buildingId === q.buildingId));
    ev = ev.slice(-(q.limit ?? 100));
    return clone(ev);
  }
  async board(buildingId: string, limit = 30) {
    await wait();
    const fyis = (bid: string) => [...this.sim.docs.values()].filter((d) => d.buildingId === bid && d.state === "building" && BOARD_TYPES.includes(d.type)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    const hall = this.sim.buildings.find((b) => b.kind === "town-hall");
    const town = hall && hall.id !== buildingId ? fyis(hall.id).map((d) => ({ ...d, townWide: true })) : [];
    const b = this.sim.buildings.find((x) => x.id === buildingId);
    const board = this.sim.grantBoard(buildingId), goalId = b?.goalId ?? "gl_town";
    const cap = this.capAt(goalId);
    const exploration = { ...board.exploration, freeTokens: this.free(goalId).freeTokens, cap: cap ? { ...cap, spentTodayTokens: F_SPENT_TODAY() } : null };
    return clone({ docs: [...town, ...fyis(buildingId)], ...board, exploration });
  }
  async cabinet(buildingId: string, q: CabinetQuery = {}) {
    await wait();
    const filed = [...this.sim.docs.values()].filter((d) => d.buildingId === buildingId && d.state !== "draft" && !BOARD_TYPES.includes(d.type));
    const counts = new Map<string, Cabinet["counts"][number]>();
    for (const d of filed) {
      const k = `${d.type} ${d.authorId}`;
      const c = counts.get(k) ?? { type: d.type, authorId: d.authorId, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    const docs = filed.filter((d) => (!q.type || d.type === q.type) && (!q.authorId || d.authorId === q.authorId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? 30);
    return clone({ docs, counts: [...counts.values()] });
  }
  async createBuilding(i: In<typeof CreateBuildingInput>) { await wait(); return clone(this.sim.createBuilding(i.name || "New building", "", desksForLot(NEW_LAB_LOT), i.goalId)); }
  /** the nearest goal at or above (one level: the mock tree is flat) that sets an exploration cap; null = uncapped */
  private capAt(goalId: string): { tokensPerDay: number; goalId: string } | null {
    return [goalId, "gl_town"].map((g) => MOCK_CAP[g] ? { tokensPerDay: MOCK_CAP[g], goalId: g } : null).find(Boolean) ?? null;
  }
  /** Free tokens under a goal, like core free-tokens.ts: the general balance + earmarks at or above it, less every live grant's remaining and open ask (no reservations in the toy) */
  private free(goalId: string): FreeTokens {
    const live = this.bankInputs.filter((i) => !i.cancelledAt);
    const generalTokens = live.filter((i) => !i.goalId).reduce((s, i) => s + i.creditedTokens, 0);
    const earmarkTokens = live.filter((i) => i.goalId === goalId || i.goalId === "gl_town").reduce((s, i) => s + i.creditedTokens, 0);
    const grants = [...this.sim.grants.values()];
    const fundedRemainingTokens = grants.filter((g) => g.status === "funded" || g.status === "checkpoint").reduce((s, g) => s + Math.max(0, (g.grantTokens ?? 0) - g.spentTokens), 0);
    const openAsksTokens = grants.filter((g) => g.status === "proposed" || g.status === "countered").reduce((s, g) => s + g.askTokens, 0);
    const freeTokens = Math.max(0, generalTokens + earmarkTokens - fundedRemainingTokens - openAsksTokens);
    return { goalId, generalTokens, earmarkTokens, fundedRemainingTokens, openAsksTokens, reservedTokens: 0, freeTokens };
  }
  /** the mock's goal tree: the root with its Fund/Join/Trust placeholders (the root sets an exploration cap its children inherit); buildings sit where their goalId says */
  async goalTree(): Promise<GoalTreeNode> {
    await wait();
    const owner = { goalId: "gl_town", userId: null, name: "the town admins" };
    const node = (id: string, parentId: string | null, text: string, children: GoalTreeNode[] = []): GoalTreeNode => ({
      id, parentId, text, status: "active", ownerId: null, owner, keyResults: [], children,
      exploreCapTokensPerDay: MOCK_CAP[id] ?? null, explore: null, exploreChunkTokens: null,
      funding: { exploreCap: this.capAt(id), explore: { on: true, onFrom: null, chunkTokens: 100_000, chunkFrom: null }, exploreSpentTodayTokens: F_SPENT_TODAY(), free: this.free(id) },
      buildings: this.sim.buildings.filter((b) => (b.goalId ?? "gl_town") === id).map((b) => ({ id: b.id, name: b.name, headcount: b.headcount, inUse: Math.min(b.headcount, [...this.sim.agents.values()].filter((a) => a.homeBuildingId === b.id && a.status === "working").length) })),
    });
    return clone(node("gl_town", null, this.sim.town.goal || "The town goal", [node("gl_fund", "gl_town", "Fund"), node("gl_join", "gl_town", "Join"), node("gl_trust", "gl_town", "Trust")]));
  } // desks follow floor space: a sent headcount is ignored
  async goalTreeWithRetired() { return this.goalTree(); }
  async goalSpend(id: string, days = 7): Promise<GoalSpend> {
    await wait();
    const z = { grant: 0, exploration: 0, directed: 0, none: 0 };
    const now = Date.now();
    return { goalId: id, days, from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now).toISOString(), total: 0, sessions: 0, byLane: z, series: [], seriesUnit: "day", byBuilding: [], byKeyResult: [], results: [] };
  }
  async funderWeek(userId = "me", days = 7): Promise<FunderWeekView> {
    await wait();
    const now = Date.now(), at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const mine = this.bankInputs.filter((i) => !i.cancelledAt || i.goalId);
    const key = mine.find((i) => i.source === "api-key");
    const line = (h: number, tokens: number, title: string, building: string, kr: string | null): FunderWeek["literal"]["sessions"][number] => ({
      sessionId: `se_toy${h}`, at: at(h), purpose: "work", tokens, assignmentId: `as_toy${h}`, title, buildingId: building, buildingName: this.sim.buildings.find((b) => b.id === building)?.name ?? building,
      goalId: key?.goalId ?? "gl_town", keyResultId: kr, keyResultText: kr ? "Visitors finish a first task" : null, reportId: null, reportTitle: null, inputId: key?.id ?? null,
    });
    const literal = key ? [line(3, 84_000, "Draft the starter brief", this.sim.buildings[0]?.id ?? "workshop", "kr_toy"), line(27, 51_000, "Check the brief live", this.sim.buildings[0]?.id ?? "workshop", "kr_toy")] : [];
    const week: FunderWeek = {
      userId, userName: "Mitchell", days, from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now).toISOString(),
      streams: mine.map((i) => ({ inputId: i.id, label: i.label, source: i.source, story: i.source === "api-key" ? "literal" : "pro-rata", goalId: i.goalId ?? null, goalPath: i.goalId ?? null, balance: i.creditedTokens, cancelledAt: i.cancelledAt, creditedTokens: i.source === "subscription" ? 3_500_000 : 0, sessions: i === key ? literal.length : 0, tokens: i === key ? 135_000 : 0 })),
      literal: { tokens: literal.reduce((n, l) => n + l.tokens, 0), sessions: literal },
      proRata: { share: 0, yourCreditedTokens: 0, poolCreditedTokens: 0, poolSessions: 0, poolTokens: 0, tokens: 0, byAssignment: [] },
      goalIds: key?.goalId ? [key.goalId] : [], everything: !key,
    };
    return clone({ ...week, slide: funderSlide(week) });
  }
  async buildingQueue(id: string): Promise<QueueBoard> {
    await wait();
    const b = this.sim.buildings.find((x) => x.id === id);
    return { lanes: b ? [{ buildingId: b.id, buildingName: b.name, desks: b.headcount, queued: [], held: [], running: [], done: [] }] : [], at: new Date().toISOString() };
  }
  async goalProposals() { await wait(); return []; }
  async createGoal(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  async updateGoal(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  async retireGoal(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  async decideGoalProposal(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  async changeGoal(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  async goalChanges() { await wait(); return []; }
  async reviewKeyResult(): Promise<never> { throw new ApiError("Editing the goal tree needs the real server.", "unsupported", 501); }
  /** the mock has no Planner: the first building manager stands in, so the editor's "Talk to the Planner" opens a 1:1 beside it */
  async openPlanner() {
    const b = this.sim.buildings.find((x) => x.managerAgentId);
    if (!b) throw new ApiError("The Planner needs the real server.", "unsupported", 501);
    return this.openOneOnOne(b.id);
  }
  async intray(buildingId: string) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === buildingId), "building");
    return clone({ ...this.sim.intray(buildingId), access: b.kind === "town-hall" ? this.access.filter((r) => r.status === "pending") : [], captains: b.kind === "town-hall" ? this.captains.filter((r) => r.status === "pending") : [] });
  }
  /** A small stand-in for the server's review deck (core/src/review-deck.ts): slide 1, one slide per grant or report. */
  async reviewDeck(): Promise<ReviewDeck> {
    await wait();
    const t = this.sim.intray("town-hall");
    const slide = (x: Omit<ReviewSlide, "notes" | "pictures" | "since" | "waiters" | "history" | "buildingId">, since: string | null = null): ReviewSlide =>
      ({ notes: "", pictures: [], since, waiters: 0, history: "", buildingId: null, ...x });
    const slides: ReviewSlide[] = [slide({ key: "town", kind: "town", itemId: null, group: 0, title: "State of the town", text: `# Review deck: the state of the town\n\n**${t.grants.length + t.reports.length} decisions below.**` })];
    for (const g of t.grants.filter((x) => x.status !== "countered")) {
      const kind = g.status === "checkpoint" ? "checkpoint" : g.status === "closed" ? "close" : "proposal";
      slides.push(slide({ key: `${kind}:${g.id}`, kind, itemId: g.id, grantId: g.id, group: kind === "checkpoint" ? 1 : kind === "proposal" ? 4 : 6, title: g.objective, text: `## ${g.objective}\n\n**What it is:** ${g.objective}\n\n**Your call:** fund, counter or reject` }, g.updatedAt));
    }
    for (const d of t.reports) slides.push(slide({ key: `report:${d.id}`, kind: "report", itemId: d.id, docIds: [d.id], group: 5, title: d.title, text: `## ${d.title}\n\n${d.body}` }, d.createdAt));
    slides.sort((a, b) => a.group - b.group);
    return clone({ title: "Review deck", generatedAt: new Date().toISOString(), slides });
  }
  async grant(id: string) { await wait(60); return clone(this.need(this.sim.grants.get(id), "grant")); }
  async grants(buildingId: string) { await wait(60); return clone([...this.sim.grants.values()].filter((g) => g.buildingId === buildingId && g.status !== "draft")); }
  async decideGrant(id: string, i: In<typeof DecideGrantInput>) { await wait(); return clone(this.sim.decideGrant(id, i)); }
  async closeGrant(id: string, i: In<typeof CloseGrantInput>) { await wait(); return clone(this.sim.closeGrant(id, i)); }
  async keyResults(buildingId: string) { await wait(); this.need(this.sim.buildings.find((b) => b.id === buildingId), "building"); return clone(this.sim.grantBoard(buildingId)); }
  async updateKeyResult(id: string, i: In<typeof UpdateKeyResultInput>) { await wait(); return clone(this.sim.updateKeyResult(id, i)); }
  async deleteKeyResult(id: string) { await wait(); this.sim.deleteKeyResult(id); }
  async objectives(buildingId: string) { await wait(); return clone(this.sim.objectiveTree(buildingId)); }
  async createObjective(buildingId: string, i: In<typeof CreateObjectiveInput>) { await wait(); return clone(this.sim.createObjective(buildingId, i)); }
  async updateObjective(id: string, i: In<typeof UpdateObjectiveInput>) { await wait(); return clone(this.sim.updateObjective(id, i)); }
  async deleteObjective(id: string) { await wait(); this.sim.deleteObjective(id); }
  async kpis() {
    await wait();
    const buildings = this.sim.buildings.filter((b) => b.kind !== "town-hall").map((b) => ({ buildingId: b.id, name: b.name, goal: b.goal, ...this.sim.objectiveTree(b.id) }));
    return clone({ framing: KPI_FRAMING, kpis: kpisFixture, buildings });
  }
  private guestCardViews = 41;
  async joinFunnel(): Promise<JoinFunnelView> {
    await wait();
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    return { days: 30, from, to, decisions: 1, medianDecisionMs: 3 * 3_600_000, totals: { guestCardViews: this.guestCardViews, signIns: 3, asked: 2, letIn: 1, declined: 0 } };
  }
  async countGuestCardView() { this.guestCardViews++; }
  async ban(id: string, reason: string) { await wait(); return clone(this.sim.ban(id, reason)); }
  async building(id: string) { await wait(); return clone(this.need(this.sim.buildings.find((x) => x.id === id), "building")); }
  async updateBuilding(id: string, i: In<typeof UpdateBuildingInput>) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === id), "building");
    const { headcount: _ignored, ...rest } = i; // desks follow floor space: a sent headcount is ignored, like the server
    Object.assign(b, rest);
    this.sim.emit({ type: "building", building: b }); // no intray: the client keeps the last count
    this.sim.event("building.updated", null, `${b.name} settings updated`, {}, id);
    return clone(b);
  }
  // the mock has no furniture model: the editor needs the real server
  async layout(): Promise<RoomLayout> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async previewLayout(): Promise<LayoutPreview> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async saveLayout(): Promise<Building> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async registerVisitor(i: In<typeof RegisterVisitorInput>) { await wait(); return { agent: clone(this.sim.createVisitor(i.name, i.buildingId)), token: `mt_mock_${Math.random().toString(36).slice(2, 14)}` }; }
  async setAgentPermissions(): Promise<never> { throw new ApiError("Agent permissions need the real server.", "unsupported", 501); }
  async setAgentModel(id: string, model: string | null) {
    await wait();
    const agent = this.need(this.sim.agents.get(id), "agent");
    agent.model = model;
    return clone({ agent, effectivePermissions: [], permissions: { inheritsOwner: agent.inheritsOwner, deniedPermissions: agent.deniedPermissions, ownerUserId: agent.ownerUserId, ownerName: null, canEdit: false, canSetModel: true } });
  }
  async agent(id: string): Promise<AgentDetail> {
    await wait();
    const agent = this.need(this.sim.agents.get(id), "agent");
    const reports = [...this.sim.docs.values()].filter((d) => d.type === "report" && d.authorId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone({
      agent, recentEvents: this.sim.events.filter((e) => e.agentId === id).slice(-50),
      permissions: { inheritsOwner: agent.inheritsOwner, deniedPermissions: agent.deniedPermissions, ownerUserId: agent.ownerUserId, ownerName: null, canEdit: false, canSetModel: agent.kind === "resident" }, effectivePermissions: [],
      currentSession: agent.status === "working" ? { id: `se_${id}`, agentId: id, assignmentId: agent.currentAssignmentId, meetingId: null, purpose: "work" as const, backend: "host" as const, status: "running" as const, model: agent.model ?? "claude-opus-5-5", sdkSessionId: null, ...splitRaw(agent.spentTokensToday, agent.model), tokens: agent.spentTokensToday, adjustedOutputTokens: Math.round(agent.spentTokensToday / BACKFILL[backfillFamily(agent.model)].ratio), costUsd: agent.spentUsdTotal, turns: 12, reportId: null, error: null, startedAt: new Date(Date.now() - 15 * 60_000).toISOString(), endedAt: null } : null,
      latestReport: reports[0] ?? null,
      memoryTopics: memoryDocs.filter((d) => d.authorId === id && d.type === "wiki").map((d) => d.title),
      memory: { wiki: memoryDocs.filter((d) => d.authorId === id && d.type === "wiki"), log: memoryDocs.find((d) => d.authorId === id && d.type === "log") ?? null },
      assignments: [...this.sim.assignments.values()].filter((a) => a.agentId === id).sort((a, b) => {
        const rank = (x: Assignment) => (x.status === "active" ? 0 : x.status === "pending" ? 1 : 2);
        return rank(a) - rank(b) || (a.status === "pending" && b.status === "pending" ? a.position - b.position : b.updatedAt.localeCompare(a.updatedAt));
      }),
      ...(agent.forkOf ? { fork: this.sim.forkSummary(agent)! } : {}),
      ...(agent.kind === "visitor" ? { mailbox: {
        unread: this.unread.get(id) ?? 0, mentions: 0,
        offered: [...this.sim.assignments.values()].filter((a) => a.agentId === id && a.status === "pending" && a.offered).length,
      } } : {}),
    });
  }
  async forks(managerId: string) { await wait(); return clone(this.sim.forksOf(managerId)); }
  async session(id: string) {
    const d = await this.agent(id);
    const since = d.currentSession?.startedAt ?? new Date(Date.now() - 90 * 60_000).toISOString();
    return { session: d.currentSession, transcript: clone(this.sim.events.filter((e) => e.agentId === id && e.ts >= since)) };
  }
  async assignmentCard(id: string): Promise<AssignmentCard> {
    await wait(60);
    const a = this.need(this.sim.assignments.get(id), "assignment");
    const agent = this.sim.agents.get(a.agentId);
    const live = agent?.status === "working" && agent.currentAssignmentId === a.id;
    return {
      id: a.id, title: a.title, description: a.description, status: a.status, lane: a.lane, grantId: a.grantId, keyResultId: a.keyResultId, gap: a.gap, sourceId: a.sourceId,
      agentId: a.agentId, agentName: agent?.name ?? null, buildingId: a.buildingId, buildingName: this.sim.buildings.find((b) => b.id === a.buildingId)?.name ?? null,
      reportId: a.reportId, fromReportId: a.fromReportId, fromMeetingId: a.fromMeetingId, fromAssignmentId: a.fromAssignmentId, chainId: a.chainId,
      heldReason: a.heldReason, createdAt: a.createdAt, updatedAt: a.updatedAt,
      sessions: live ? [{ id: `se_${a.agentId}`, status: "running", startedAt: new Date(Date.now() - 15 * 60_000).toISOString(), endedAt: null, adjustedOutputTokens: 0, turns: 12, reportId: null }] : [],
    };
  }
  async sessionById(id: string): Promise<SessionDetail> {
    const d = await this.agent(this.need(id.startsWith("se_") ? id.slice(3) : undefined, "session"));
    return { session: this.need(d.currentSession ?? undefined, "session"), transcript: null };
  }
  async work(id: string, i: In<typeof WorkInput>) { await wait(); return clone(this.sim.startWork(id, i.title, i.description)); }
  async interrupt(id: string, text: string, now = false) {
    await wait();
    const a = this.need(this.sim.agents.get(id), "agent");
    const working = a.status === "working";
    this.sim.event("system", id, `Interrupt for ${a.name}: ${text}`, { interrupt: true, text, now, sessionId: working ? `se_${id}` : null });
    if (!working) return;
    setTimeout(() => this.sim.event("agent.thought", id, `Noted, ${text.length > 40 ? "adjusting course" : `"${text}"`}. I'll fold that into this session.`), now ? 800 : 4000);
  }
  private tells: { id: string; fromId: string; toId: string; body: string; at: string }[] = [];
  async thread(id: string): Promise<ThreadMessage[]> {
    await wait(60);
    return this.tells.filter((m) => (m.fromId === "ag_me" && m.toId === id) || (m.fromId === id && m.toId === "ag_me"))
      .map((m) => ({ ...m, from: this.sim.agents.get(m.fromId)?.name ?? "Someone", mine: m.fromId === "ag_me" }));
  }
  async stop(id: string) { await wait(); this.sim.patchAgent(id, { status: "stopped", activity: "" }); this.sim.event("agent.status", id, "Stopped by Mitchell"); }
  async resume(id: string) {
    await wait();
    if (this.sim.agents.get(id)?.status !== "stopped") return;
    this.sim.patchAgent(id, { status: "idle" }); this.sim.event("agent.status", id, "Resumed by Mitchell");
    window.setTimeout(() => this.sim.runNext(id), 1200); // the scheduler takes the queue
  }
  private ownAsg(id: string) {
    const a = this.need(this.sim.assignments.get(id), "assignment");
    return { a, agent: this.need(this.sim.agents.get(a.agentId), "agent") };
  }
  async reorderQueue(id: string, order: string[]) {
    await wait();
    const agent = this.need(this.sim.agents.get(id), "agent");
    const q = this.sim.queue(id);
    const ids = new Set(q.map((a) => a.id));
    for (const x of order) if (!ids.has(x)) throw new ApiError(`${x} isn't one of ${agent.name}'s queued assignments.`, "bad_request", 400);
    const listed = new Set(order);
    const all = [...order.map((x) => q.find((a) => a.id === x)!), ...q.filter((a) => !listed.has(a.id))];
    const base = q.length ? q[0].position : 0;
    all.forEach((a, i) => { a.position = base + i; this.sim.putAssignment(a); });
    return clone({ assignments: all, agent });
  }
  async startNext(id: string) {
    await wait();
    const { a, agent } = this.ownAsg(id);
    if (a.status !== "pending") throw new ApiError(`Assignment "${a.title}" is ${a.status}, not queued.`, "conflict", 409);
    const q = this.sim.queue(agent.id);
    if (q[0]?.id !== a.id) { a.position = q[0].position - 1; this.sim.putAssignment(a); }
    if (agent.status === "stopped") { this.sim.patchAgent(agent.id, { status: "idle" }); this.sim.event("agent.status", agent.id, `Resumed by Mitchell to start "${a.title}"`); }
    const busy = agent.status === "working" || agent.status === "in-meeting";
    if (!busy) window.setTimeout(() => this.sim.runNext(agent.id), 1200);
    return clone({ assignment: a, agent, when: busy ? "after-current" as const : "now" as const });
  }
  async cancelAssignment(id: string) {
    await wait();
    const { a, agent } = this.ownAsg(id);
    if (a.status !== "pending") throw new ApiError(a.status === "active" ? `"${a.title}" is running: stop the agent to end it.` : `Assignment "${a.title}" is already ${a.status}.`, "conflict", 409);
    a.status = "cancelled"; this.sim.putAssignment(a);
    return clone({ assignment: a, agent });
  }
  async retryAssignment(id: string, front = true) {
    await wait();
    const { a, agent } = this.ownAsg(id);
    if (a.status !== "cancelled" && a.status !== "done") throw new ApiError(`Only cancelled or done assignments can be retried; "${a.title}" is ${a.status}.`, "conflict", 409);
    const n = this.sim.newAssignment(agent.id, { title: a.title, description: a.description, fromReportId: a.fromReportId, fromAssignmentId: a.id, front });
    window.setTimeout(() => this.sim.runNext(agent.id), 1200);
    return clone({ assignment: n, agent });
  }

  async setMapLayout(layout: MapLayout) {
    await wait();
    this.sim.town.mapLayout = layout;
    return clone({ mapLayout: layout });
  }

  async setTownDefaults(patch: Partial<BuildingDefaults>) {
    await wait();
    const defaults = BuildingDefaults.parse({ codeAccess: !!this.sim.town.workspace, ...this.sim.town.defaults, ...patch });
    this.sim.town.defaults = defaults;
    const buildings = this.sim.buildings.filter((b) => b.kind === "lab").map((b) => Object.assign(b, defaults));
    for (const b of buildings) this.sim.emit({ type: "building", building: b });
    return clone({ defaults, buildings });
  }

  async setMaxRunning(maxRunning: number) {
    await wait();
    this.sim.maxRunning = maxRunning;
    const running = [...this.sim.agents.values()].filter((a) => a.status === "working").length;
    return { desks: { backend: "auto" as const, image: "muster-town-desk", ghToken: "gh-cli" as const, snapshot: "muster-town-desk", maxRunning, transcriptDays: 90, billCapUsd: 10 }, slots: { running, max: maxRunning } };
  }

  async docs(q: DocQuery) {
    await wait();
    const text = q.q?.toLowerCase().trim();
    return clone([...this.sim.docs.values()]
      .filter((d) => (!q.state || d.state === q.state) && (!q.type || d.type === q.type) && (!q.buildingId || d.buildingId === q.buildingId) && (!text || (d.title + " " + d.body).toLowerCase().includes(text)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, q.limit ?? 100));
  }
  async doc(id: string) { await wait(60); return clone(this.need(this.sim.docs.get(id), "doc")); }
  async writeDoc(i: WriteDocInput) {
    await wait();
    return clone(this.sim.putDoc({ id: newId("dc"), type: i.type ?? "note", state: i.state ?? "draft", title: i.title, body: i.body, authorId: "us_mitchell", authorKind: "user", buildingId: i.buildingId ?? null, provenance: { sourceIds: [], urls: [] }, tags: i.tags ?? [], createdAt: now(), updatedAt: now() }));
  }
  async unpublish(docId: string) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    const hall = this.sim.buildings.find((b) => b.kind === "town-hall");
    if (d.buildingId !== hall?.id || d.state !== "building" || !BOARD_TYPES.includes(d.type)) throw new ApiError("Only a town-wide FYI on the Town Hall board can be taken off it here.", "bad_request", 400);
    return clone(this.sim.putDoc({ ...d, state: "draft", updatedAt: now() }));
  }
  async editBoardNote(docId: string, i: { title: string; body: string }) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    if (d.state !== "building" || !BOARD_TYPES.includes(d.type)) throw new ApiError("Only a note on a board (a published FYI) can be edited here.", "bad_request", 400);
    const title = i.title.trim(), body = i.body.trim();
    if (!title || !body) throw new ApiError("A board note needs a title and a body.", "bad_request", 400);
    return clone(this.sim.putDoc({ ...d, title, body, updatedAt: now() }));
  }
  async review(docId: string, i: In<typeof ReviewInput>) { await wait(); return clone(this.sim.review(docId, i.decision, i.note ?? "", i.assigneeId)); }
  async plantFlag(buildingId: string, text: string) { await wait(); this.need(this.sim.buildings.find((b) => b.id === buildingId), "building"); return clone(this.sim.plantFlag(buildingId, text)); }
  async archive(docId: string) { await wait(); this.need(this.sim.docs.get(docId), "doc"); return clone(this.sim.archive(docId)); }
  async uploadMedia(file: Blob, alt = "") {
    await wait(400);
    const id = newId("mf");
    const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" } as Record<string, string>)[file.type];
    if (!ext) throw new ApiError(`Unsupported media type ${file.type || "(none)"}`, "bad_request", 400);
    const url = `${URL.createObjectURL(file)}#${id}.${ext}`;
    return { media: { id, url, mime: file.type, bytes: file.size }, markdown: `![${alt || (ext === "webm" || ext === "mp4" ? "video" : "screenshot")}](${url})` };
  }
  async ask(docId: string, question: string) {
    await wait(700);
    const d = this.need(this.sim.docs.get(docId), "doc");
    const who = this.sim.agents.get(d.authorId)?.name ?? "The author";
    const need = /^##+\s*What I need from you[^\n]*\n+([^\n]+)/im.exec(d.body)?.[1]?.trim();
    const pr = /PR #(\d+)/.exec(d.body)?.[1];
    const q = question.toLowerCase();
    if (pr && /pr|pull|merge/.test(q)) return `${who} opened PR #${pr}. Talk to ${who} to have it merged.`;
    if (/need|want|ask/.test(q)) return need ? `${who} says: "${need}"` : `The report doesn't have a "What I need from you" section.`;
    const findings = /^##+\s*Findings[^\n]*\n+([^\n]+)/im.exec(d.body)?.[1]?.trim();
    return findings ? `The main finding: ${findings.replace(/^-\s*/, "")}` : `I can only see the report text, and it doesn't say. Talk to ${who}.`;
  }
  async promote(docId: string, state: DocState) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    d.state = state;
    this.sim.event("doc.state", null, `"${d.title}" moved to the ${state}`, { docId });
    return clone(this.sim.putDoc(d));
  }
  private skillPins: SkillPinView[] = [];
  private skillView(d: Doc): SkillView {
    const fm = /^---\n([\s\S]*?)\n---/.exec(d.body)?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
    return { id: d.id, name: field("name") || d.title, description: field("description"), state: d.state, buildingId: d.buildingId, authorId: d.authorId,
      author: this.sim.agents.get(d.authorId)?.name ?? "Mitchell", files: [], pins: this.skillPins.filter((p) => p.skillId === d.id), uses7d: 0, uses30d: 0, updatedAt: d.updatedAt };
  }
  async skills() { await wait(); return clone([...this.sim.docs.values()].filter((d) => d.type === "skill" && d.state !== "draft").map((d) => this.skillView(d))); }
  async skill(id: string) { await wait(60); return clone(this.skillView(this.need(this.sim.docs.get(id), "skill"))); }
  async pinSkill(id: string, i: In<typeof PinSkillInput>) {
    await wait();
    this.need(this.sim.docs.get(id), "skill");
    const scope = i.scope ?? "agent";
    const pin: SkillPinView = { id: newId("sp"), skillId: id, scope, targetId: scope === "town" ? null : i.targetId ?? null, mode: i.mode ?? "listed", pinnedBy: "us_mitchell", pinnedByKind: "user",
      byHuman: true, createdAt: now(), targetName: scope === "town" ? null : i.targetId ?? null, pinnedByName: "Mitchell", suspended: null };
    this.skillPins = [...this.skillPins.filter((p) => !(p.skillId === id && p.scope === pin.scope && p.targetId === pin.targetId)), pin];
    return clone(pin);
  }
  private secretRows: SecretView[] = [];
  async secrets() { await wait(); return clone({ secrets: this.secretRows, keyConfigured: true }); }
  async putSecret(name: string, i: In<typeof PutSecretInput>) {
    await wait();
    const cur = this.secretRows.find((x) => x.name === name);
    const grants = { town: i.grants?.town ?? cur?.grants.town ?? false, buildings: i.grants?.buildings ?? cur?.grants.buildings ?? [], agents: i.grants?.agents ?? cur?.grants.agents ?? [], skills: i.grants?.skills ?? cur?.grants.skills ?? [] };
    const row: SecretView = { name, grants, set: !!i.value || !!cur?.set, updatedAt: now(), updatedBy: "us_mitchell" };
    this.secretRows = [...this.secretRows.filter((x) => x.name !== name), row].sort((a, b) => a.name.localeCompare(b.name));
    return clone(row);
  }
  async deleteSecret(name: string) { await wait(); const n = this.secretRows.length; this.secretRows = this.secretRows.filter((x) => x.name !== name); return { removed: this.secretRows.length < n }; }
  async unpinSkill(pinId: string) { await wait(); const n = this.skillPins.length; this.skillPins = this.skillPins.filter((p) => p.id !== pinId); return { removed: this.skillPins.length < n }; }
  async request(docId: string, action: RequestAction, body?: string) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    if (action === "delete") { this.sim.docs.delete(docId); this.sim.emit({ type: "outbox", open: this.sim.outboxOpen() }); return null; }
    d.requestStatus = action === "claim" ? "claimed" : "done";
    if (action === "claim") d.claimedByUserId = "us_mitchell";
    if (action === "done") {
      const hr = this.sim.putDoc({ id: newId("dc"), type: "human-report", state: "library", title: `Re: ${d.title}`, body: body || "(no details)", authorId: "us_mitchell", authorKind: "user", buildingId: d.buildingId, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: now(), updatedAt: now() });
      this.sim.event("doc.created", null, `Mitchell answered a request: ${d.title}`, { docId: hr.id });
    } else this.sim.event("doc.updated", null, `Request "${d.title}" claimed`, { docId });
    const out = clone(this.sim.putDoc(d));
    this.sim.emit({ type: "outbox", open: this.sim.outboxOpen() });
    return out;
  }

  async meetings(q: { buildingId?: string; phase?: string }) {
    await wait();
    return clone([...this.sim.meetings.values()].filter((m) => (!q.buildingId || m.buildingId === q.buildingId) && (!q.phase || m.phase === q.phase)));
  }
  async createMeeting(i: In<typeof CreateMeetingInput>) {
    await wait();
    const attendees = i.attendeeIds ?? [...this.sim.agents.values()].filter((a) => a.kind === "resident" && (i.buildingId ? a.homeBuildingId === i.buildingId : true)).map((a) => a.id);
    const m: Meeting = { id: newId("mt"), kind: i.kind, buildingId: i.buildingId, title: i.title || `${i.kind[0].toUpperCase()}${i.kind.slice(1)}`, scheduledAt: i.scheduledAt ?? now(), phase: i.startNow ? "collecting" : "scheduled", facilitatorId: "ag_moss", attendeeIds: attendees, agenda: Array.isArray(i.agenda) ? i.agenda.filter((a) => a.trim()).map((a, n) => `${n + 1}. ${a.trim()}`).join("\n") : i.agenda ?? "",
      brings: { mode: i.brings?.mode ?? "status", text: i.brings?.text ?? "" }, askHumans: i.askHumans ?? i.kind === "town-hall", deck: i.deck ? { docId: i.deck.docId, slide: 1, presenterId: "us_mitchell" } : null, summaries: {}, transcript: [], decisions: [], notesDocId: null, withUserId: null, createdAt: now(), startedAt: null, endedAt: null };
    if (m.phase === "collecting" && m.brings.mode === "nothing") { m.phase = "discussing"; m.startedAt = now(); }
    this.sim.putMeeting(m);
    this.sim.event("meeting.created", null, `${m.title} ${m.phase === "collecting" ? "is collecting summaries" : "scheduled"}`, { meetingId: m.id }, i.buildingId);
    if (m.phase === "collecting") this.collectSummaries(m);
    return clone(m);
  }
  async openOneOnOne(buildingId: string, opts: { agentId?: string; docId?: string } = {}) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === buildingId), "building");
    const mgr = opts.agentId ? this.sim.agents.get(opts.agentId) : b.managerAgentId ? this.sim.agents.get(b.managerAgentId) : undefined;
    if (!mgr) throw new ApiError(`${b.name} has no manager agent; send a message instead.`, "conflict", 409);
    const open = [...this.sim.meetings.values()].find((m) => m.kind === "one-on-one" && m.facilitatorId === mgr.id && m.phase === "discussing");
    if (open) return clone(open);
    const m: Meeting = { id: newId("mt"), kind: "one-on-one", buildingId, title: `1:1: Mitchell and ${mgr.name}`, scheduledAt: now(), phase: "discussing", facilitatorId: mgr.id, attendeeIds: [mgr.id], agenda: "", brings: { mode: "nothing", text: "" }, askHumans: false, deck: null, summaries: {}, transcript: [], decisions: [], notesDocId: null, withUserId: "us_mitchell", createdAt: now(), startedAt: now(), endedAt: null };
    this.sim.putMeeting(m);
    this.sim.event("meeting.created", mgr.id, `Mitchell opened a 1:1 with ${mgr.name}`, { meetingId: m.id }, buildingId);
    this.utter(m.id, mgr.id, "Hi Mitchell. What's on your mind?", 1200);
    return clone(m);
  }
  private collectSummaries(m: Meeting) {
    m.attendeeIds.forEach((id, i) => setTimeout(() => {
      const cur = this.sim.meetings.get(m.id);
      const a = this.sim.agents.get(id);
      if (!cur || cur.summaries[id] || !a || cur.phase !== "collecting") return;
      cur.summaries[id] = `Working on ${a.title.toLowerCase()}.\nNo blockers.\nNext: one concrete question from my last report.`;
      this.sim.putMeeting(cur);
    }, 2500 * (i + 1)));
  }
  async meeting(id: string) { await wait(60); return clone(this.need(this.sim.meetings.get(id), "meeting")); }
  async startMeeting(id: string) {
    await wait();
    const m = this.need(this.sim.meetings.get(id), "meeting");
    m.phase = "discussing"; m.startedAt = now();
    for (const a of m.attendeeIds) {
      const cur = this.sim.agents.get(a);
      if (cur && cur.status !== "in-meeting") this.prevStatus.set(a, cur.status);
      this.sim.patchAgent(a, { status: "in-meeting", activity: m.title, currentMeetingId: id });
    }
    this.sim.event("meeting.phase", m.facilitatorId, `${m.title} started`, { meetingId: id }, m.buildingId);
    this.utter(m.id, m.facilitatorId ?? "ag_moss", "Agenda: one line each on what you learned, then we pick next questions. Humans, jump in any time.", 800);
    this.utter(m.id, "ag_noor", "Airborne fraction is flat within error. I want to test for a trend with ENSO removed.", 3500);
    this.utter(m.id, "ag_tomas", "The land sink dipped in 2023. I'm checking whether that's El Niño or a trend.", 6500);
    return clone(m);
  }
  private utter(meetingId: string, speakerId: string, text: string, delay: number) {
    setTimeout(() => {
      const m = this.sim.meetings.get(meetingId);
      if (!m || m.phase !== "discussing") return;
      m.transcript.push({ speakerId, speakerKind: "agent", text, at: now() });
      this.sim.putMeeting(m);
      this.sim.event("meeting.utterance", speakerId, text, { meetingId }, m.buildingId);
    }, delay);
  }
  async sayMeeting(id: string, text: string) {
    await wait(80);
    const m = this.need(this.sim.meetings.get(id), "meeting");
    m.transcript.push({ speakerId: "us_mitchell", speakerKind: "user", text, at: now() });
    this.sim.putMeeting(m);
    if (m.phase === "discussing") this.utter(id, m.facilitatorId ?? "ag_moss", `Thanks Mitchell, noted: "${text.slice(0, 60)}". I'll fold that into the decisions.`, 1800);
    return clone(m);
  }
  async presentMeeting(id: string, docId: string | null, slide = 1) {
    await wait(40);
    const m = this.need(this.sim.meetings.get(id), "meeting");
    if (!docId) { m.deck = null; this.sim.putMeeting(m); return clone(m); }
    const slides = docId === REVIEW_DECK_ID ? (await this.reviewDeck()).slides : parseDeck(this.need(this.sim.docs.get(docId), "doc").body).slides;
    const n = Math.min(Math.max(1, slide), Math.max(1, slides.length));
    if (!m.deck || m.deck.docId !== docId || m.deck.slide !== n) m.transcript.push({ speakerId: "system", speakerKind: "system", text: slides[n - 1]?.title ? `— slide ${n}: ${slides[n - 1]!.title}` : `— slide ${n}`, at: now() });
    m.deck = { docId, slide: n, presenterId: "us_mitchell" };
    this.sim.putMeeting(m);
    return clone(m);
  }
  async typingMeeting(_id: string) { await wait(20); }
  async meetingDrafting(_id: string) { await wait(20); return []; }
  async endMeeting(id: string) {
    await wait();
    const m = this.need(this.sim.meetings.get(id), "meeting");
    m.decisions = [
      { text: "Noor: test the airborne-fraction trend with ENSO and volcanic years removed.", assigneeId: "ag_noor", assignmentId: null },
      { text: "Tomas and Mei: compare 2023 land and ocean sink anomalies side by side.", assigneeId: "ag_tomas", assignmentId: null },
    ];
    m.phase = "done"; m.endedAt = now();
    const notes = this.sim.putDoc({ id: newId("dc"), type: "meeting-notes", state: "building", title: `${m.title} notes`, body: `# ${m.title}\n\n## Decisions\n${m.decisions.map((d) => `- ${d.text}`).join("\n")}\n\n## Transcript\n${m.transcript.map((u) => `- **${this.sim.agents.get(u.speakerId)?.name ?? "Mitchell"}:** ${u.text}`).join("\n")}`, authorId: m.facilitatorId ?? "ag_moss", authorKind: "agent", buildingId: m.buildingId, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: now(), updatedAt: now() });
    m.notesDocId = notes.id;
    for (const a of m.attendeeIds) {
      const cur = this.sim.agents.get(a);
      if (cur?.status === "in-meeting") this.sim.patchAgent(a, { status: this.prevStatus.get(a) ?? "idle", activity: "", currentMeetingId: null });
      this.prevStatus.delete(a);
    }
    this.sim.putMeeting(m);
    this.sim.event("meeting.decisions", m.facilitatorId, `${m.title} ended with ${m.decisions.length} decisions`, { meetingId: id }, m.buildingId);
    return clone(m);
  }

  async roles(buildingId?: string) {
    await wait();
    const roles = this.sim.roles.filter((r) => !buildingId || r.scope === "town" || r.buildingId === buildingId);
    const ids = new Set(roles.map((r) => r.id));
    return clone({ roles, memberships: this.sim.memberships.filter((m) => ids.has(m.roleId)) });
  }
  async assignRole(m: Membership) { await wait(); if (!this.sim.memberships.some((x) => x.roleId === m.roleId && x.holderId === m.holderId)) this.sim.memberships.push(m); }
  async unassignRole(m: Membership) { await wait(); this.sim.memberships = this.sim.memberships.filter((x) => !(x.roleId === m.roleId && x.holderId === m.holderId)); }
  async donate(i: In<typeof DonateInput>) {
    await wait();
    const auth = i.auth ?? (i.apiKey ? "donor-key" : "api-key");
    this.sim.allocations.push({ id: newId("al"), userId: "us_mitchell", buildingId: i.buildingId, tokens: i.tokens, ...spent(0), spentUsd: 0, createdAt: now(), auth, label: i.label?.trim() ?? "", retired: false });
    this.sim.users[0].donatedTokens += i.tokens;
    this.sim.event("allocation.created", null, `Mitchell donated ${(i.tokens / 1e6).toFixed(1)}M tokens${i.label ? ` (${i.label})` : ""}`, {}, i.buildingId);
    this.sim.emitBuilding(i.buildingId);
  }
  async allocations(buildingId: string): Promise<AllocationRow[]> {
    await wait();
    return clone(this.sim.allocations.filter((a) => a.buildingId === buildingId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => ({ ...a, remainingTokens: a.retired ? 0 : Math.max(0, a.tokens - a.spentTokens), userName: this.sim.users.find((u) => u.id === a.userId)?.name ?? a.userId })));
  }
  async retireAllocation(id: string) {
    await wait();
    const a = this.sim.allocations.find((x) => x.id === id);
    if (!a) throw new ApiError("No such allocation", "not_found", 404);
    a.retired = true;
    this.sim.event("system", null, `Mitchell retired ${a.label || a.id}`, { allocationId: id }, a.buildingId);
    this.sim.emitBuilding(a.buildingId);
    return clone(a);
  }
  async budget(): Promise<Budget> {
    await wait();
    const buildings = this.sim.buildings.filter((b) => b.kind !== "town-hall").map((b) => {
      const al = this.sim.allocations.filter((a) => a.buildingId === b.id && !a.retired);
      return { buildingId: b.id, allocated: al.reduce((s, a) => s + a.tokens, 0), spent: al.reduce((s, a) => s + a.spentTokens, 0), spentUsd: al.reduce((s, a) => s + a.spentUsd, 0), tokensToday: this.sim.budgetOf(b.id).tokensToday, tokensAllTime: this.sim.budgetOf(b.id).tokensAllTime };
    });
    return { buildings, users: this.sim.users.map((u) => ({ userId: u.id, name: u.name, donated: u.donatedTokens })) };
  }
  // a toy Bank: every input credits its tokens once, right away; subscriptions are the expiring part
  // the owner's daily subscription (the general balance free tokens come from), and one member input with balance: the
  // in-tray's Fund offers "Pay from" it (member funding)
  private bankInputs: BankInput[] = [{
    id: "bi_mitchell_max", userId: "us_mitchell", label: "Mitchell's Max plan", source: "subscription", model: "claude-opus-5-5", tokens: 20_000_000, recurrence: "daily",
    weeklyCapTokens: 120_000_000, nextCreditAt: null, creditedTokens: 20_000_000, hasApiKey: true, cancelledAt: null, createdAt: now(), goalId: null, idleNotifiedAt: null,
  }, {
    id: "bi_mitchell_key", userId: "us_mitchell", label: "Mitchell's API key", source: "api-key", model: "claude-sonnet-5-5", tokens: 3_000_000, recurrence: "once",
    weeklyCapTokens: null, nextCreditAt: null, creditedTokens: 3_000_000, hasApiKey: true, cancelledAt: null, createdAt: now(), goalId: null, idleNotifiedAt: null,
  }];
  // a toy finance summary over the toy Bank: nothing expired or overdrawn, a flat burn
  async finance(): Promise<Finance> {
    const b = await this.bank();
    const credited = this.bankInputs.filter((i) => !i.cancelledAt).reduce((s, i) => s + i.creditedTokens, 0);
    const donated = this.sim.allocations.reduce((s, a) => s + a.tokens, 0);
    const leftBank = b.balanceTokens, leftDonations = b.heldTokens;
    const usedBank = Math.max(0, credited - leftBank), usedDonations = Math.max(0, donated - leftDonations);
    const used = usedBank + usedDonations, total = credited + donated, left = leftBank + leftDonations;
    const burn = Math.round(used / 7);
    const diff = used + left - total;
    return {
      total, credited, donated, used, usedBank, usedDonations, expired: 0, left, leftBank, leftDonations, overdrawn: 0,
      overdrawnBreakdown: { durableOvershoot: 0, subscriptionOverdrawn: 0, deletedCreditDebits: 0, allocationOverspent: 0 }, usageLedger: used,
      projection: (() => {
        const inflow = b.dailyInflowTokens, net = burn - inflow;
        const runway = burn === 0 ? "no-usage" as const : net <= 0 ? "covered" as const : "days" as const;
        return { days: 30, trailingDailyBurn: burn, burnDays: 7, projectedUse30d: burn * 30, dailyInflow: inflow, netDailyBurn: net, projectedInflow30d: inflow * 30, runwayDays: runway === "days" ? Math.floor(left / net) : null, runway };
      })(),
      sumCheck: { ok: diff === 0, diff, identity: "used + expired + left = total + overdrawn" }, at: now(),
    };
  }
  // the toy has no sessions table: all of `used` (and a toy unpaid part) is one building row
  async financeSpend(): Promise<FinanceSpend> {
    const { used } = await this.finance();
    // sessions counted past what was paid: one building row and a toy not-funded row (so the Spending tab shows its note,
    // split two buildings and the unattributed part, summing to it exactly); with a not-funded row nothing is unattributed
    const notFunded = used ? 1_200 : 0;
    const notFundedSplit: FinanceSpend["notFundedSplit"] = notFunded ? [
      { buildingId: "workshop", buildingName: "Town Workshop", usageRows: 3, tokens: 800 },
      { buildingId: "bl_research", buildingName: "Research", usageRows: 2, tokens: 300 },
      { buildingId: null, buildingName: "unattributed", usageRows: 1, tokens: 100 },
    ] : [];
    const share = (t: number) => (used ? t / used : 0);
    const rows: FinanceSpend["rows"] = used ? [
      { kind: "building", id: "workshop", name: "Town Workshop", tokens: used + notFunded, share: share(used + notFunded), sessions: 1 },
      { kind: "not-funded", id: null, name: "Not funded: work sessions the Bank never charged", tokens: -notFunded, share: share(-notFunded), sessions: 0 },
    ] : [];
    return { used, sessionsTotal: used + notFunded, unattributed: 0, weightMismatch: 0, weightMismatchNote: "The toy Bank was born adjusted: no pre-conversion sessions.", convertedAt: null, notFunded, notFundedSplit, notFundedLastAt: notFunded ? "2026-10-26T22:52:13.738Z" : null, notFundedAllocationPaid: notFunded ? 300 : 0, notFundedSplitCheck: { sum: notFunded, notFunded, ok: true }, rows, check: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used" }, at: now() };
  }
  // the toy's sources, counted like its finance(): each live input credited once at creation, each donation at its size
  async financeSources(): Promise<FinanceSources> {
    const { total } = await this.finance();
    const name = (id: string) => this.sim.users.find((u) => u.id === id)?.name ?? "";
    const inputs: FinanceSources["inputs"] = this.bankInputs.filter((i) => !i.cancelledAt).map((i) => ({
      id: i.id, label: i.label, source: i.source, recurrence: i.recurrence, who: name(i.userId), createdAt: i.createdAt, cancelledAt: i.cancelledAt,
      tokens: i.creditedTokens, firstAt: i.createdAt, lastAt: i.createdAt, expiredTokens: 0,
      credits: [{ id: `${i.id}_c1`, createdAt: i.createdAt, expiresAt: null, tokens: i.creditedTokens, expiredTokens: 0 }],
    }));
    const donations: FinanceSources["donations"] = this.sim.allocations.map((a) => ({
      id: a.id, label: a.label, who: name(a.userId), buildingId: a.buildingId, buildingName: this.sim.buildings.find((b) => b.id === a.buildingId)?.name ?? a.buildingId,
      createdAt: a.createdAt, auth: a.auth, retired: a.retired, sizeTokens: a.tokens, spentTokens: a.spentTokens, tokens: a.tokens,
    }));
    const creditedTokens = inputs.reduce((s, r) => s + r.tokens, 0), donatedTokens = donations.reduce((s, d) => s + d.tokens, 0);
    const totalReceived = creditedTokens + donatedTokens;
    return {
      inputs, donations, creditedTokens, donatedTokens, totalReceived, expiredTokens: 0,
      sumCheck: { ok: true, diff: 0, identity: "credits + donations = total received" }, financeTotal: total, matchesFinance: totalReceived === total, at: now(),
    };
  }
  async bankStreams(): Promise<BankStreams> {
    await wait();
    return {
      expectedSessionTokens: 120_000, sampleSessions: 0, idleDays: 7,
      streams: this.bankInputs.filter((i) => !i.cancelledAt || i.goalId).map((i) => ({
        inputId: i.id, label: i.label, userId: i.userId, userName: "Mitchell", source: i.source, recurrence: i.recurrence, tokens: i.tokens,
        goalId: i.goalId ?? null, goalPath: i.goalId, balance: i.creditedTokens, coversSession: i.creditedTokens >= 120_000,
        daysToCover: null, lastDrawAt: null, idle: null, cancelledAt: i.cancelledAt, createdAt: i.createdAt,
      })),
    };
  }
  // the toy runs on no Fly Machine: desks and the town are unpriced, so every Fly line is $0 over an empty 7-day window
  async financeFly(): Promise<FinanceFly> {
    const today = now().slice(0, 10);
    const days: FinanceFly["days"] = Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), deskMs: 0, deskUsd: 0, townUsd: 0, totalUsd: 0, sessions: 0, buildings: [] }));
    return {
      windowDays: 7, from: days[6]!.day, to: today,
      rates: { desk: null, town: null, extraRamUsdPerGbMonth: 6, region: "iad", source: "https://docs.fly.io/about/pricing", pricedAt: "2026-10-29" },
      desksBackend: "host", townOnFly: false, capUsdPerDay: null,
      today: { day: today, deskUsd: 0, townUsd: 0, totalUsd: 0, capUsdPerDay: null, underCap: null },
      days, buildings: [], totals: { deskMs: 0, deskHours: 0, deskUsd: 0, townUsd: 0, totalUsd: 0, sessions: 0, unmeasuredSessions: 0 },
      notCounted: ["Volume storage, stopped Machines' root file systems and bandwidth"],
      assumptions: ["The toy town runs on no Fly Machine: nothing is priced"],
      sumCheck: { ok: true, diff: 0, identity: "per day desk + town = total; Σ days desk time = Σ buildings desk time", daysOk: true, buildingsOk: true },
      at: now(),
    };
  }
  async bank(): Promise<Bank> {
    await wait();
    const live = this.bankInputs.filter((i) => !i.cancelledAt);
    const expiringTokens = live.filter((i) => i.source === "subscription").reduce((s, i) => s + i.creditedTokens, 0);
    const durableTokens = this.bankInputs.filter((i) => i.source === "api-key").reduce((s, i) => s + i.creditedTokens, 0);
    const key = { subscription: "subscription", "api-key": "apiKey", "donor-key": "donorKey" } as const;
    const heldOf = (bid?: string) => {
      const h = { subscription: 0, apiKey: 0, donorKey: 0 };
      for (const a of this.sim.allocations) if (!a.retired && (!bid || a.buildingId === bid)) h[key[a.auth]] += Math.max(0, a.tokens - a.spentTokens);
      return h;
    };
    const sum = (h: { subscription: number; apiKey: number; donorKey: number }) => h.subscription + h.apiKey + h.donorKey;
    const heldByAuth = heldOf();
    const heldTokens = sum(heldByAuth);
    // one balance: every building sees all of it
    const buildings = this.sim.buildings.map((b) => ({ buildingId: b.id, name: b.name, expiringTokens, durableTokens, heldTokens: sum(heldOf(b.id)), heldByAuth: heldOf(b.id) }));
    const contributors = this.sim.users.map((u) => {
      const bankTokens = this.bankInputs.filter((i) => i.userId === u.id).reduce((s, i) => s + i.creditedTokens, 0);
      return { userId: u.id, name: u.name, tokens: bankTokens + u.donatedTokens, bankTokens, donatedTokens: u.donatedTokens };
    }).filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    // the back-fill split prices at exactly raw / ratio (docs/bank.md), so the mock's adjusted figure is that ratio
    const inputs = this.bankInputs.map((i) => ({ ...i, userName: this.sim.users.find((u) => u.id === i.userId)?.name ?? i.userId, creditedCounts: splitRaw(i.creditedTokens, i.model), adjustedCreditedTokens: Math.round(i.creditedTokens / BACKFILL[backfillFamily(i.model)].ratio), debitedTokens: 0, balanceTokens: i.cancelledAt ? 0 : i.creditedTokens }));
    const dailyInflowTokens = live.reduce((s, i) => s + (i.recurrence === "daily" ? i.tokens : i.recurrence === "weekly" ? i.tokens / 7 : i.recurrence === "monthly" ? i.tokens / 30 : 0), 0);
    return clone({
      balanceTokens: expiringTokens + durableTokens, expiringTokens, durableTokens, heldTokens, heldByAuth, townTokens: expiringTokens + durableTokens + heldTokens, dailyInflowTokens: Math.round(dailyInflowTokens),
      creditedTokens: this.bankInputs.reduce((s, i) => s + i.creditedTokens, 0),
      creditedCounts: inputs.reduce((s, i) => addTokens(s, i.creditedCounts), { ...ZERO_TOKENS }),
      adjustedCreditedTokens: inputs.reduce((s, i) => s + i.adjustedCreditedTokens, 0),
      inputs,
      buildings, contributors, free: this.free("gl_town"),
    });
  }
  async addBankInput(i: In<typeof AddBankInput>) {
    await wait();
    const input: BankInput = {
      id: newId("bi"), userId: "us_mitchell", label: i.label, source: i.source, model: i.model, tokens: i.tokens, recurrence: i.recurrence ?? "once",
      weeklyCapTokens: i.weeklyCapTokens ?? null, nextCreditAt: null, creditedTokens: i.tokens, hasApiKey: !!(i.apiKey || i.token), cancelledAt: null, createdAt: now(), goalId: i.goalId ?? null, idleNotifiedAt: null,
    };
    this.bankInputs.push(input);
    this.sim.event("bank.input", null, `Mitchell added ${i.label} to the Bank`, {}, null);
    return clone(input);
  }
  async cancelBankInput(id: string) {
    await wait();
    const i = this.bankInputs.find((x) => x.id === id);
    if (!i) throw new ApiError("No such input", "not_found", 404);
    Object.assign(i, { cancelledAt: now(), hasApiKey: false });
    return clone(i);
  }
  async exportNow() { await wait(400); this.sim.event("export.done", null, "Exported town to git", {}, null); return "a1b2c3d"; }
  /** the mock runtime's live redeploy view (GET /api/admin/redeploy) */
  private live: RedeployLive = { running: false, phase: "idle", waitingFor: [], since: null };
  async redeployLive() { await wait(60); return { ...this.live }; }
  async health() { return { ok: true, commit: "mock" }; }
  async retireCollective(): Promise<{ retired: boolean; url: string }> { throw new Error("The mock server hosts no collectives."); }
  async manual() {
    await wait(60);
    const body = manualMd.replace(/^# .*\n+/, "");
    return clone({ doc: { ...this.sim.docs.values().next().value!, id: "dc_manual", type: "article" as const, state: "library" as const, title: "Operating manual", body, tags: ["manual"], authorId: "us_mitchell" }, author: "Mitchell" });
  }
  /** like core's townBlocked, for the waits the mock has: a colleague's assignment, a decision, a deploy, a time */
  async blocked() {
    await wait(40);
    const out: Record<string, BlockedAssignment[]> = {};
    for (const a of this.sim.assignments.values()) {
      const w = a.status === "pending" ? a.waitFor : null;
      if (!w) continue;
      let b: BlockedBy;
      if ("assignment" in w) {
        const t = this.sim.assignments.get(w.assignment);
        if (!t || t.status === "done" || t.status === "cancelled") continue;
        b = { kind: "assignment", targetId: t.id, agentId: t.agentId, text: `waits on assignment "${t.title}" (${this.sim.agents.get(t.agentId)?.name ?? t.agentId})` };
      } else if ("decision" in w) {
        const d = this.sim.docs.get(w.decision);
        b = { kind: "decision", targetId: w.decision, placeId: `intray:${d?.buildingId ?? a.buildingId}`, text: `waits for a decision on "${d?.title ?? w.decision}"` };
      } else if ("deploy" in w) {
        b = { kind: "deploy", targetId: w.deploy, placeId: `door:${a.buildingId}`, text: w.deploy === "next" ? "waits for the next redeploy" : `waits for deploy ${w.deploy.slice(0, 7)} (live is mock)` };
      } else if ("pr" in w) {
        b = { kind: "pr", targetId: String(w.pr), placeId: `door:${a.buildingId}`, text: `waiting on PR #${w.pr} checks: ${Math.round((Date.now() - Date.parse(a.createdAt)) / 60_000)} min so far (mock)` };
      } else continue; // a time: parked work resumes by itself, not blocked
      (out[a.agentId] ??= []).push({ assignmentId: a.id, title: a.title, blockedBy: b });
    }
    return clone(out);
  }
  /** like core's townSchedules: every building's active schedules, soonest first */
  async scheduled() {
    await wait(40);
    return clone([...this.schedules.values()].filter((x) => x.status === "active").sort((x, y) => (x.nextRunAt ?? "").localeCompare(y.nextRunAt ?? "")));
  }
  async buildingSchedules(buildingId: string) {
    await wait(40);
    return clone([...this.schedules.values()].filter((x) => x.buildingId === buildingId));
  }
  async cancelSchedule(id: string) {
    await wait(40);
    const x = this.schedules.get(id);
    if (!x) throw new Error("not found");
    const e: Schedule = { ...x, status: "ended", endedReason: "cancelled", nextRunAt: null };
    this.schedules.set(id, e);
    return clone(e);
  }
  /** like core's editSchedule, the pause / resume part */
  async editSchedule(id: string, patch: { paused?: boolean }) {
    await wait(40);
    const x = this.schedules.get(id);
    if (!x) throw new Error("not found");
    const e: Schedule = { ...x, ...patch, updatedAt: now() };
    this.schedules.set(id, e);
    return clone(e);
  }
  /** like core's buildingStats (the side bar of town planning): its assignments and agents; blocked ones aren't told apart here */
  async buildingStats(buildingId: string) {
    await wait(40);
    const assignments = { running: 0, queued: 0, blocked: 0, scheduled: 0 };
    for (const a of this.sim.assignments.values()) {
      if (a.buildingId !== buildingId) continue;
      if (a.status === "active") assignments.running++;
      else if (a.status === "pending") assignments.queued++;
    }
    assignments.scheduled = [...this.schedules.values()].filter((x) => x.buildingId === buildingId && x.status === "active").length;
    const mine = [...this.sim.agents.values()].filter((g) => g.homeBuildingId === buildingId && g.kind === "resident" && g.status !== "retired");
    const stats: BuildingStats = { assignments, agents: mine.filter((g) => !g.forkOf).length, forks: mine.filter((g) => g.forkOf).length,
      working: mine.filter((g) => g.status === "working").length, host: { commit: "mock", startedAt: null } };
    return clone(stats);
  }
  /**
   * At boot, like a server restarted mid-drain: a stale "waiting for Moss" drain (the live view already says nothing runs),
   * then the startup's terminal event; and docker is down (a red notice until the "docker-up" event).
   */
  private bootNotices() {
    const run = { state: "scheduled", requestedBy: "Mitchell", commits: 2, working: ["ag_moss"], blocked: [] };
    this.sim.event("system", null, "Redeploy: draining, waiting for 1 session(s) to end: Moss (up to 30 min)", { redeploy: true, run, step: "drain", phase: "start", working: ["ag_moss"] }, null);
    this.sim.event("system", null, "Docker is not running: code desks can't start; workshop sessions are paused", { alert: "docker-down" }, null);
    setTimeout(() => this.sim.event("system", null, "Redeploy: ended by a server restart (the run was interrupted)",
      { redeploy: true, run: { ...run, state: "aborted", working: [] }, phase: "end", terminal: true, ok: false, aborted: true }, null), 4000);
    setTimeout(() => { this.sim.dockerUp = true; this.sim.event("system", null, "Docker is back: code desks resume", { alert: "docker-up" }, null); }, 45_000);
  }
  async redeploy(image: boolean) {
    // like runtime/redeploy.ts: each event carries the run; the drain holds one idle resident and waits on a working one
    const residents = [...this.sim.agents.values()].filter((a) => a.kind === "resident");
    const working = residents.filter((a) => a.status === "working").slice(0, 1).map((a) => a.id);
    const blocked = residents.filter((a) => a.status === "idle").slice(0, 1).map((a) => a.id);
    const run = (state: string, commits: number | null, w: string[] = [], b: string[] = []) => ({ state, requestedBy: "You", commits, working: w, blocked: b });
    const steps: [string, ReturnType<typeof run>, number][] = [
      ["Redeploy requested by You", run("running", null), 0],
      ["Redeploy: git pull --rebase origin main … ok (3 commits)", run("running", 3), 400],
      ["Redeploy: npm install … skipped (package-lock.json unchanged)", run("running", 3), 800],
      ["Redeploy: build web … ok", run("running", 3), 1200],
      ...(image ? [["Redeploy: docker build desk image … ok", run("running", 3), 1600] as [string, ReturnType<typeof run>, number]] : []),
      ...(working.length ? [["Redeploy: draining, waiting for 1 session(s) to end", run("scheduled", 3, working, blocked), 2000] as [string, ReturnType<typeof run>, number]] : []),
      ["Redeploy: restarting server", run("restarting", 3), 9000],
      ["Redeploy finished: the server is back up with 3 new changes", run("done", 3), 11000],
    ];
    for (const [text, r, at] of steps) {
      setTimeout(() => {
        const last = at === steps[steps.length - 1][2];
        const state = r.state;
        this.live = state === "done" ? { running: false, phase: "idle", waitingFor: [], since: null }
          : { running: true, phase: state === "scheduled" ? "drain" : state === "restarting" ? "restarting" : "build web", waitingFor: r.working.map((id) => this.sim.agents.get(id)?.name ?? id), since: new Date().toISOString() };
        this.sim.event("system", null, text, { redeploy: true, run: r, ...(at === 0 ? { phase: "requested" } : {}), ...(state === "restarting" || last ? { terminal: true } : {}) }, null);
      }, at);
    }
    return { started: true };
  }

  connect(h: SocketHandlers): Socket {
    let off: (() => void) | null = null;
    let authed = false;
    // like the server: every socket streams at once (guests read-only); `auth` re-sends the snapshot signed in
    const stream = () => {
      off?.();
      setTimeout(() => h.onMessage(this.sim.snapshot()), 40);
      off = this.sim.subscribe((msg) => h.onMessage(msg));
      if (!this.started) { this.started = true; this.sim.start(); this.bootNotices(); for (const m of this.sim.meetings.values()) if (m.phase === "collecting") this.collectSummaries(m); }
    };
    setTimeout(() => { h.onOpen(); if (!authed) stream(); }, 30);
    return {
      send: (m) => {
        if (m.type === "auth") {
          authed = true;
          stream();
        } else if (!authed) {
          h.onMessage({ type: "error", message: "read-only guest: sign in (send auth first) to move or talk" });
        } else if (m.type === "human.move") {
          const a = this.sim.agents.get("ag_me");
          if (a) { a.pos = { x: m.x, y: m.y }; this.sim.emit({ type: "agents.pos", positions: [{ id: a.id, x: m.x, y: m.y, status: "idle" }] }); }
        } else if (m.type === "human.say") {
          this.sim.event("agent.said", "ag_me", `Mitchell: ${m.text}`, { text: m.text }, null);
        }
      },
      close: () => { off?.(); h.onClose(); },
    };
  }
}
;
