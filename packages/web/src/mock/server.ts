/** `Api` implemented against the in-memory Sim. Same interface as HttpApi, so every panel works offline. */
import type { AccessRequest, AccessRequestView, Agent, Assignment, AuthMe, BlockedAssignment, BlockedBy, Building, Doc, Event, Meeting, Membership, RedeployLive } from "@muster-town/schema";
import { BACKFILL, BOARD_TYPES, DEFAULT_POOL_ID, ZERO_TOKENS, addTokens, backfillFamily, splitRaw, type BankPool } from "@muster-town/schema";
import type { Api, AgentDetail, AllocationRow, Bank, Budget, Cabinet, CabinetQuery, DocQuery, EventQuery, In, LayoutPreview, MessageResult, PlanPreview, RoomLayout, RequestAction, Snapshot, Socket, SocketHandlers, ThreadMessage, WriteDocInput } from "../api";
import { ApiError } from "../api";
import type { PinSkillInput, PutSecretInput, SecretView, SkillPinView, SkillView } from "@muster-town/schema";
import type { CreateBuildingInput, UpdateBuildingInput, CreateResidentInput, RegisterVisitorInput, ReviewInput, ChatInput, WorkInput, DonateInput, CreateMeetingInput, DocState, AddBankInput, BankInput, CreateBankPoolInput, UpdateBankPoolInput, DecideGrantInput, CreateKeyResultInput, UpdateKeyResultInput } from "@muster-town/schema";
import { Sim, newId, spent } from "./sim";
import { memoryDocs } from "./fixture";

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export class MockApi implements Api {
  readonly mock = true;
  private sim = new Sim();
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
  async me(): Promise<AuthMe> {
    await wait(60);
    // `?as=visitor` signs in as a plain visitor so read-only views can be checked
    if (new URLSearchParams(location.search).get("as") === "visitor") {
      const mine = [...this.access].reverse().find((r) => r.userId === "us_guest");
      return clone({ user: { ...this.sim.users[0], id: "us_guest", name: "Guest", githubLogin: "guest" }, roles: this.sim.roles.filter((r) => r.id === "rl_visitor"), avatarAgentId: "ag_me", isAdmin: false,
        canInteract: mine?.status === "granted", accessRequest: mine ? { status: mine.status, message: mine.message, decidedAt: mine.decidedAt } : null });
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
    const docs = [...this.sim.docs.values()].filter((d) => d.buildingId === buildingId && d.state === "building" && BOARD_TYPES.includes(d.type)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    return clone({ docs, ...this.sim.grantBoard(buildingId) });
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
  async createBuilding(i: In<typeof CreateBuildingInput>) { await wait(); return clone(this.sim.createBuilding(i.name, i.goal ?? "", i.headcount ?? 6)); }
  async intray(buildingId: string) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === buildingId), "building");
    return clone({ ...this.sim.intray(buildingId), access: b.kind === "town-hall" ? this.access.filter((r) => r.status === "pending") : [] });
  }
  async grant(id: string) { await wait(60); return clone(this.need(this.sim.grants.get(id), "grant")); }
  async decideGrant(id: string, i: In<typeof DecideGrantInput>) { await wait(); return clone(this.sim.decideGrant(id, i)); }
  async keyResults(buildingId: string) { await wait(); this.need(this.sim.buildings.find((b) => b.id === buildingId), "building"); return clone(this.sim.grantBoard(buildingId)); }
  async createKeyResult(buildingId: string, i: In<typeof CreateKeyResultInput>) { await wait(); return clone(this.sim.createKeyResult(buildingId, i)); }
  async updateKeyResult(id: string, i: In<typeof UpdateKeyResultInput>) { await wait(); return clone(this.sim.updateKeyResult(id, i)); }
  async deleteKeyResult(id: string) { await wait(); this.sim.deleteKeyResult(id); }
  async dismiss(id: string, purge = false) { await wait(); this.sim.dismiss(id, purge); }
  async ban(id: string, reason: string) { await wait(); return clone(this.sim.ban(id, reason)); }
  async updateBuilding(id: string, i: In<typeof UpdateBuildingInput>) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === id), "building");
    const headcountChanged = i.headcount !== undefined && i.headcount !== b.headcount;
    Object.assign(b, i);
    this.sim.emit({ type: "building", building: b }); // no intray: the client keeps the last count
    if (headcountChanged) this.sim.relayout();
    this.sim.event("building.updated", null, `${b.name} settings updated`, {}, id);
    return clone(b);
  }
  // the mock has no furniture model: the editor needs the real server
  async layout(): Promise<RoomLayout> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async previewLayout(): Promise<LayoutPreview> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async previewPlan(): Promise<PlanPreview> { throw new ApiError("Town planning needs the real server.", "unsupported", 501); }
  async savePlan(): Promise<{ buildings: Building[]; created: Building | null }> { throw new ApiError("Town planning needs the real server.", "unsupported", 501); }
  async saveLayout(): Promise<Building> { throw new ApiError("Edit layout needs the real server.", "unsupported", 501); }
  async registerVisitor(i: In<typeof RegisterVisitorInput>) { await wait(); return { agent: clone(this.sim.createVisitor(i.name, i.buildingId)), token: `mt_mock_${Math.random().toString(36).slice(2, 14)}` }; }
  async createResident(i: In<typeof CreateResidentInput>) { await wait(); return clone(this.sim.createResident(i.buildingId, i.name || await this.suggestName(), i.title ?? "", i.direction ?? "", i.sprite)); }
  async suggestName(avoid: string[] = []) {
    const taken = new Set([...[...this.sim.agents.values()].map((a) => a.name), ...avoid].map((n) => n.toLowerCase()));
    return ["Lena", "Milo", "Wren", "Juno", "Kai", "Rhea", "Otto", "Sana"].find((n) => !taken.has(n.toLowerCase())) ?? `Resident ${this.sim.agents.size + 1}`;
  }
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
      ...(agent.kind === "visitor" ? { mailbox: {
        unread: this.unread.get(id) ?? 0, mentions: 0,
        offered: [...this.sim.assignments.values()].filter((a) => a.agentId === id && a.status === "pending" && a.offered).length,
      } } : {}),
    });
  }
  async session(id: string) {
    const d = await this.agent(id);
    const since = d.currentSession?.startedAt ?? new Date(Date.now() - 90 * 60_000).toISOString();
    return { session: d.currentSession, transcript: clone(this.sim.events.filter((e) => e.agentId === id && e.ts >= since)) };
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
  async chat(id: string, i: In<typeof ChatInput>) {
    await wait(700);
    const a = this.need(this.sim.agents.get(id), "agent");
    if (a.kind === "service") {
      const q = i.message.toLowerCase();
      const STOP = new Set(["have", "anything", "what", "about", "there", "does", "with", "that", "this", "where", "which", "know"]);
      const words = q.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
      const hits = [...this.sim.docs.values()].filter((d) => (d.state === "library" || d.state === "trophy") && words.some((w) => (d.title + d.body).toLowerCase().includes(w))).slice(0, 3);
      return hits.length ? `I found ${hits.length} in the library: ${hits.map((d) => `"${d.title}"`).join(", ")}. Open the Library tab to read them.` : `Nothing in the library matches that yet. The closest thing is "GCB 2025 ESSD", our main source for the carbon budget.`;
    }
    const asg = a.currentAssignmentId ? this.sim.assignments.get(a.currentAssignmentId) : null;
    if (/redirect|instead|change|switch/.test(i.message.toLowerCase())) return `I can't change direction from chat. Message me from the Talk tab, or Redirect on my report at the in-tray.`;
    if (a.status === "working") return `I'm working on "${asg?.title}". Right now: ${a.activity.toLowerCase()}. I expect to submit a report in a few minutes.`;
    const pending = [...this.sim.docs.values()].find((d) => d.type === "report" && d.authorId === a.id && d.decision === "pending");
    if (pending) return `My last report, "${pending.title}", is in the in-tray on the manager's desk. I'm idle until someone gives me an assignment.`;
    return `I'm ${a.status} at my desk. My standing direction: ${a.direction.split(":")[0]}. Message me from the Talk tab and I'll get going.`;
  }
  private tells: { id: string; fromId: string; toId: string; body: string; at: string }[] = [];
  private tell(fromId: string, toId: string, body: string, extra: Record<string, unknown> = {}) {
    const m = { id: newId("ms"), fromId, toId, body, at: now() };
    this.tells.push(m);
    const from = this.sim.agents.get(fromId), to = this.sim.agents.get(toId);
    this.sim.event("agent.told", fromId, `${from?.name ?? "Someone"} → ${to?.name ?? "someone"}: ${body.slice(0, 200)}`, { to: toId, toId, messageId: m.id, text: body, ...extra }, from?.homeBuildingId ?? null);
    return m;
  }
  async message(id: string, raw: string, nowFlag = true): Promise<MessageResult> {
    await wait();
    const a = this.need(this.sim.agents.get(id), "agent");
    const text = raw.trim();
    if (!text) throw new ApiError("Message is empty.", "bad_request", 400);
    const m = this.tell("ag_me", id, text, { fromUser: "us_mitchell" });
    // v1.4: a visitor's loop runs outside the town: the message waits in its mailbox
    if (a.kind === "visitor") { this.unread.set(id, (this.unread.get(id) ?? 0) + 1); return { mode: "queued", messageId: m.id }; }
    const wasWorking = a.status === "working";
    // scripted reply: a short `tell` back, then (idle) the session runs as usual
    const reply = (ms: number) => setTimeout(() => this.tell(id, "ag_me", /\?\s*$/.test(text)
      ? `Good question. I'll check the cabinet and the GCB source, then report back in this session.`
      : `Got it, thanks. I'll ${wasWorking ? "fold that into what I'm doing now" : "start on it right away"}.`), ms);
    if (a.status === "working") {
      if (!nowFlag) return { mode: "queued", messageId: m.id };
      this.sim.event("system", id, `Interrupt for ${a.name}: ${text}`, { interrupt: true, text, now: true, sessionId: `se_${id}` });
      setTimeout(() => this.sim.event("agent.thought", id, "A message from Mitchell. Replying first, then adjusting course."), 700);
      reply(1500);
      return { mode: "interrupted", messageId: m.id };
    }
    if (a.status === "stopped") this.sim.patchAgent(id, { status: "idle" });
    const first = text.split("\n")[0];
    // the message goes to the front of the queue, so it runs next even with a backlog
    const asg = this.sim.newAssignment(id, { title: `Message from Mitchell: ${first.length > 80 ? first.slice(0, 79) + "…" : first}`, description: `Mitchell messaged you:\n\n${text}`, front: true });
    this.sim.runNext(id);
    setTimeout(() => this.sim.event("agent.tool", id, "inbox · 1 unread", { tool: "inbox" }), 600);
    reply(1600);
    return { mode: "started", messageId: m.id, assignmentId: asg.id };
  }
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

  async delegateAssignment(id: string, agentId: string, front = true) {
    await wait();
    const { a, agent } = this.ownAsg(id);
    if (a.status !== "pending") throw new ApiError(`Assignment "${a.title}" is ${a.status}, not queued.`, "conflict", 409);
    const to = this.need(this.sim.agents.get(agentId), "agent");
    if (to.id === agent.id) throw new ApiError(`"${a.title}" is already ${agent.name}'s.`, "bad_request", 400);
    if (to.kind !== "resident") throw new ApiError(`${to.name} is a ${to.kind}; only residents take delegated assignments.`, "bad_request", 400);
    a.status = "cancelled"; this.sim.putAssignment(a);
    const n = this.sim.newAssignment(to.id, { title: a.title, description: a.description, fromReportId: a.fromReportId, fromAssignmentId: a.id, front });
    window.setTimeout(() => this.sim.runNext(to.id), 1200);
    return clone({ assignment: n, agent: to, from: a });
  }

  async setMaxRunning(maxRunning: number) {
    await wait();
    this.sim.maxRunning = maxRunning;
    const running = [...this.sim.agents.values()].filter((a) => a.status === "working").length;
    return { desks: { backend: "auto" as const, image: "muster-town-desk", ghToken: "gh-cli" as const, snapshot: "muster-town-desk", maxRunning }, slots: { running, max: maxRunning } };
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
    return clone(this.sim.putDoc({ id: newId("dc"), type: i.type ?? "note", state: i.state ?? "draft", title: i.title, body: i.body, authorId: "us_mitchell", authorKind: "user", buildingId: null, provenance: { sourceIds: [], urls: [] }, tags: i.tags ?? [], createdAt: now(), updatedAt: now() }));
  }
  async review(docId: string, i: In<typeof ReviewInput>) { await wait(); return clone(this.sim.review(docId, i.decision, i.note ?? "", i.assigneeId)); }
  async plantFlag(buildingId: string, text: string) { await wait(); this.need(this.sim.buildings.find((b) => b.id === buildingId), "building"); return clone(this.sim.plantFlag(buildingId, text)); }
  async reply(docId: string, text: string) { await wait(); this.need(this.sim.docs.get(docId), "doc"); return clone(this.sim.reply(docId, text)); }
  async archive(docId: string) { return this.reply(docId, ""); }
  async ask(docId: string, question: string) {
    await wait(700);
    const d = this.need(this.sim.docs.get(docId), "doc");
    const who = this.sim.agents.get(d.authorId)?.name ?? "The author";
    const need = /^##+\s*What I need from you[^\n]*\n+([^\n]+)/im.exec(d.body)?.[1]?.trim();
    const pr = /PR #(\d+)/.exec(d.body)?.[1];
    const q = question.toLowerCase();
    if (pr && /pr|pull|merge/.test(q)) return `${who} opened PR #${pr}. Reply "merge" and ${who} will ready and squash-merge it next session, then report back.`;
    if (/need|want|ask/.test(q)) return need ? `${who} says: "${need}"` : `The report doesn't have a "What I need from you" section.`;
    const findings = /^##+\s*Findings[^\n]*\n+([^\n]+)/im.exec(d.body)?.[1]?.trim();
    return findings ? `The main finding: ${findings.replace(/^-\s*/, "")}` : `I can only see the report text, and it doesn't say. Ask ${who} in a reply.`;
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
  async trophy(docId: string, approve: boolean) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    if (approve) d.state = "trophy"; else { d.trophyProposedBy = undefined; d.trophyWhy = undefined; }
    this.sim.event("doc.state", null, approve ? `"${d.title}" is now a trophy` : `Trophy proposal for "${d.title}" declined`, { docId });
    return clone(this.sim.putDoc(d));
  }
  async request(docId: string, action: RequestAction, body?: string) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    const next = { approve: "approved", reject: "rejected", claim: "claimed", done: "done" } as const;
    d.requestStatus = next[action];
    if (action === "approve") d.state = "library";
    if (action === "claim") d.claimedByUserId = "us_mitchell";
    if (action === "done") {
      const hr = this.sim.putDoc({ id: newId("dc"), type: "human-report", state: "library", title: `Re: ${d.title}`, body: body || "(no details)", authorId: "us_mitchell", authorKind: "user", buildingId: d.buildingId, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: now(), updatedAt: now() });
      this.sim.event("doc.created", null, `Mitchell answered a request: ${d.title}`, { docId: hr.id });
    } else this.sim.event("doc.updated", null, `Request "${d.title}" ${next[action]}`, { docId });
    return clone(this.sim.putDoc(d));
  }

  async meetings(q: { buildingId?: string; phase?: string }) {
    await wait();
    return clone([...this.sim.meetings.values()].filter((m) => (!q.buildingId || m.buildingId === q.buildingId) && (!q.phase || m.phase === q.phase)));
  }
  async createMeeting(i: In<typeof CreateMeetingInput>) {
    await wait();
    const attendees = i.attendeeIds ?? [...this.sim.agents.values()].filter((a) => a.kind === "resident" && (i.buildingId ? a.homeBuildingId === i.buildingId : true)).map((a) => a.id);
    const m: Meeting = { id: newId("mt"), kind: i.kind, buildingId: i.buildingId, title: i.title || `${i.kind[0].toUpperCase()}${i.kind.slice(1)}`, scheduledAt: i.scheduledAt ?? now(), phase: i.startNow ? "collecting" : "scheduled", facilitatorId: "ag_moss", attendeeIds: attendees, agenda: i.agenda ?? "", summaries: {}, transcript: [], decisions: [], notesDocId: null, withUserId: null, createdAt: now(), startedAt: null, endedAt: null };
    this.sim.putMeeting(m);
    this.sim.event("meeting.created", null, `${m.title} ${m.phase === "collecting" ? "is collecting summaries" : "scheduled"}`, { meetingId: m.id }, i.buildingId);
    if (m.phase === "collecting") this.collectSummaries(m);
    return clone(m);
  }
  async openOneOnOne(buildingId: string) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === buildingId), "building");
    const mgr = b.managerAgentId ? this.sim.agents.get(b.managerAgentId) : undefined;
    if (!mgr) throw new ApiError(`${b.name} has no manager agent; send a message instead.`, "conflict", 409);
    const open = [...this.sim.meetings.values()].find((m) => m.kind === "one-on-one" && m.buildingId === buildingId && m.phase === "discussing");
    if (open) return clone(open);
    const m: Meeting = { id: newId("mt"), kind: "one-on-one", buildingId, title: `1:1: Mitchell and ${mgr.name}`, scheduledAt: now(), phase: "discussing", facilitatorId: mgr.id, attendeeIds: [mgr.id], agenda: "", summaries: {}, transcript: [], decisions: [], notesDocId: null, withUserId: "us_mitchell", createdAt: now(), startedAt: now(), endedAt: null };
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
  async typingMeeting(_id: string) { await wait(20); }
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
  // a toy Bank: every input credits its tokens once, right away; subscriptions are the expiring pool
  private bankInputs: BankInput[] = [];
  // accounting pools: buildings without a poolId are in General; pools without a pct split what's left equally
  private bankPools: BankPool[] = [{ id: DEFAULT_POOL_ID, name: "General", pct: null, createdAt: now() }];
  private poolOf(b: Building) { return this.bankPools.some((p) => p.id === b.poolId) ? b.poolId! : DEFAULT_POOL_ID; }
  async bank(): Promise<Bank> {
    await wait();
    const live = this.bankInputs.filter((i) => !i.cancelledAt);
    const expiringTokens = live.filter((i) => i.source === "subscription").reduce((s, i) => s + i.creditedTokens, 0);
    const durableTokens = this.bankInputs.filter((i) => i.source === "api-key").reduce((s, i) => s + i.creditedTokens, 0);
    const members = (poolId: string) => this.sim.buildings.filter((b) => this.poolOf(b) === poolId);
    // like core: only a pool with a building that can draw (not just the Town Hall) gets an auto share
    const draws = (poolId: string) => members(poolId).some((b) => b.kind !== "town-hall");
    const used = this.bankPools.reduce((s, p) => s + (p.pct ?? 0), 0);
    const auto = this.bankPools.filter((p) => p.pct === null && draws(p.id));
    const pctOf = (p: BankPool) => p.pct ?? (draws(p.id) ? Math.max(0, 100 - used) / auto.length : 0);
    const pools = this.bankPools.map((p) => ({
      id: p.id, name: p.name, pct: Math.round(pctOf(p) * 100) / 100, explicit: p.pct !== null, isDefault: p.id === DEFAULT_POOL_ID,
      buildings: members(p.id).map((b) => ({ buildingId: b.id, name: b.name })),
      expiringTokens: Math.floor(expiringTokens * pctOf(p) / 100), durableTokens: Math.floor(durableTokens * pctOf(p) / 100),
    }));
    const key = { subscription: "subscription", "api-key": "apiKey", "donor-key": "donorKey" } as const;
    const heldOf = (bid?: string) => {
      const h = { subscription: 0, apiKey: 0, donorKey: 0 };
      for (const a of this.sim.allocations) if (!a.retired && (!bid || a.buildingId === bid)) h[key[a.auth]] += Math.max(0, a.tokens - a.spentTokens);
      return h;
    };
    const sum = (h: { subscription: number; apiKey: number; donorKey: number }) => h.subscription + h.apiKey + h.donorKey;
    const heldByAuth = heldOf();
    const heldTokens = sum(heldByAuth);
    const buildings = this.sim.buildings.map((b) => {
      const pool = pools.find((p) => p.id === this.poolOf(b))!;
      const draws = b.kind !== "town-hall";
      return {
        buildingId: b.id, name: b.name, poolId: pool.id, poolName: pool.name, pct: draws ? pool.pct : 0, explicit: pool.explicit,
        expiringTokens: draws ? pool.expiringTokens : 0, durableTokens: draws ? pool.durableTokens : 0, heldTokens: sum(heldOf(b.id)), heldByAuth: heldOf(b.id),
      };
    });
    const contributors = this.sim.users.map((u) => {
      const bankTokens = this.bankInputs.filter((i) => i.userId === u.id).reduce((s, i) => s + i.creditedTokens, 0);
      return { userId: u.id, name: u.name, tokens: bankTokens + u.donatedTokens, bankTokens, donatedTokens: u.donatedTokens };
    }).filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    // the back-fill split prices at exactly raw / ratio (docs/bank.md), so the mock's adjusted figure is that ratio
    const inputs = this.bankInputs.map((i) => ({ ...i, userName: this.sim.users.find((u) => u.id === i.userId)?.name ?? i.userId, creditedCounts: splitRaw(i.creditedTokens, i.model), adjustedCreditedTokens: Math.round(i.creditedTokens / BACKFILL[backfillFamily(i.model)].ratio) }));
    const dailyInflowTokens = live.reduce((s, i) => s + (i.recurrence === "daily" ? i.tokens : i.recurrence === "weekly" ? i.tokens / 7 : i.recurrence === "monthly" ? i.tokens / 30 : 0), 0);
    return clone({
      balanceTokens: expiringTokens + durableTokens, expiringTokens, durableTokens, heldTokens, heldByAuth, townTokens: expiringTokens + durableTokens + heldTokens, dailyInflowTokens: Math.round(dailyInflowTokens),
      creditedTokens: this.bankInputs.reduce((s, i) => s + i.creditedTokens, 0),
      creditedCounts: inputs.reduce((s, i) => addTokens(s, i.creditedCounts), { ...ZERO_TOKENS }),
      adjustedCreditedTokens: inputs.reduce((s, i) => s + i.adjustedCreditedTokens, 0),
      inputs,
      pools, buildings, contributors,
    });
  }
  async addBankInput(i: In<typeof AddBankInput>) {
    await wait();
    const input: BankInput = {
      id: newId("bi"), userId: "us_mitchell", label: i.label, source: i.source, model: i.model, tokens: i.tokens, recurrence: i.recurrence ?? "once",
      weeklyCapTokens: i.weeklyCapTokens ?? null, nextCreditAt: null, creditedTokens: i.tokens, hasApiKey: !!i.apiKey, cancelledAt: null, createdAt: now(),
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
  private checkPct(poolId: string | null, pct: number | null | undefined) {
    if (pct === null || pct === undefined) return;
    const others = this.bankPools.filter((p) => p.id !== poolId).reduce((s, p) => s + (p.pct ?? 0), 0);
    if (others + pct > 100) throw new ApiError(`Shares would add up to ${others + pct}%; the most this pool can have is ${100 - others}%.`, "bad_request", 400);
  }
  async createBankPool(i: In<typeof CreateBankPoolInput>) {
    await wait();
    this.checkPct(null, i.pct);
    this.bankPools.push({ id: newId("pl"), name: i.name, pct: i.pct ?? null, createdAt: now() });
    return this.bank();
  }
  async updateBankPool(id: string, i: In<typeof UpdateBankPoolInput>) {
    await wait();
    const p = this.need(this.bankPools.find((x) => x.id === id), "pool");
    this.checkPct(id, i.pct);
    if (i.name !== undefined) p.name = i.name;
    if (i.pct !== undefined) p.pct = i.pct;
    return this.bank();
  }
  async deleteBankPool(id: string) {
    await wait();
    if (id === DEFAULT_POOL_ID) throw new ApiError("General is the default pool; it can't be deleted.", "bad_request", 400);
    if (this.sim.buildings.some((b) => this.poolOf(b) === id)) throw new ApiError("The pool still has buildings; move them out first.", "bad_request", 400);
    this.bankPools = this.bankPools.filter((p) => p.id !== id);
    return this.bank();
  }
  async setBuildingPool(buildingId: string, poolId: string | null) {
    this.need(this.bankPools.find((p) => p.id === (poolId ?? DEFAULT_POOL_ID)), "pool");
    return this.updateBuilding(buildingId, { poolId });
  }
  async exportNow() { await wait(400); this.sim.event("export.done", null, "Exported town to git", {}, null); return "a1b2c3d"; }
  /** the mock runtime's live redeploy view (GET /api/admin/redeploy) */
  private live: RedeployLive = { running: false, phase: "idle", waitingFor: [], since: null };
  async redeployLive() { await wait(60); return { ...this.live }; }
  async health() { return { ok: true, commit: "mock" }; }
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
      } else {
        if (Date.parse(w.after) <= Date.now()) continue;
        b = { kind: "after", targetId: null, text: `not before ${w.after}` };
      }
      (out[a.agentId] ??= []).push({ assignmentId: a.id, title: a.title, blockedBy: b });
    }
    return clone(out);
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
export type { Doc };
