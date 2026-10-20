/** `Api` implemented against the in-memory Sim. Same interface as HttpApi, so every panel works offline. */
import type { Agent, AuthMe, Doc, Event, Meeting, Membership } from "@agent-town/schema";
import type { Api, AgentDetail, Budget, DocQuery, EventQuery, In, RequestAction, Snapshot, Socket, SocketHandlers, WriteDocInput } from "../api";
import { ApiError } from "../api";
import type { CreateBuildingInput, UpdateBuildingInput, CreateResidentInput, ReviewInput, ChatInput, WorkInput, DonateInput, CreateMeetingInput, DocState } from "@agent-town/schema";
import { Sim, newId } from "./sim";

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export class MockApi implements Api {
  readonly mock = true;
  private sim = new Sim();
  private started = false;
  private prevStatus = new Map<string, Agent["status"]>();

  private need<T>(x: T | undefined, what: string): T {
    if (x === undefined || x === null) throw new ApiError(`${what} not found`, "not_found", 404);
    return x;
  }

  async devAdminToken() { return "mock-admin-token"; }
  async me(): Promise<AuthMe> {
    await wait(60);
    const roleIds = new Set(this.sim.memberships.filter((m) => m.holderKind === "user" && m.holderId === "us_mitchell").map((m) => m.roleId));
    return clone({ user: this.sim.users[0], roles: this.sim.roles.filter((r) => roleIds.has(r.id)), avatarAgentId: "ag_me", isAdmin: true });
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
    return clone([...this.sim.docs.values()].filter((d) => d.buildingId === buildingId && d.state === "building").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit));
  }
  async createBuilding(i: In<typeof CreateBuildingInput>) { await wait(); return clone(this.sim.createBuilding(i.name, i.goal ?? "", i.headcount ?? 6)); }
  async updateBuilding(id: string, i: In<typeof UpdateBuildingInput>) {
    await wait();
    const b = this.need(this.sim.buildings.find((x) => x.id === id), "building");
    const headcountChanged = i.headcount !== undefined && i.headcount !== b.headcount;
    Object.assign(b, i);
    this.sim.emit({ type: "building", building: b });
    if (headcountChanged) this.sim.relayout();
    this.sim.event("building.updated", null, `${b.name} settings updated`, {}, id);
    return clone(b);
  }
  async createResident(i: In<typeof CreateResidentInput>) { await wait(); return clone(this.sim.createResident(i.buildingId, i.name, i.title, i.direction, i.sprite)); }
  async agent(id: string): Promise<AgentDetail> {
    await wait();
    const agent = this.need(this.sim.agents.get(id), "agent");
    const reports = [...this.sim.docs.values()].filter((d) => d.type === "report" && d.authorId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone({
      agent, recentEvents: this.sim.events.filter((e) => e.agentId === id).slice(-50),
      currentSession: agent.status === "working" ? { id: `se_${id}`, agentId: id, assignmentId: agent.currentAssignmentId, meetingId: null, purpose: "work" as const, backend: "host" as const, status: "running" as const, model: agent.model ?? "claude-opus-5-5", sdkSessionId: null, tokens: agent.spentTokensToday, costUsd: agent.spentUsdTotal, turns: 12, reportId: null, error: null, startedAt: new Date(Date.now() - 15 * 60_000).toISOString(), endedAt: null } : null,
      latestReport: reports[0] ?? null,
      assignments: [...this.sim.assignments.values()].filter((a) => a.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }
  async session(id: string) {
    const d = await this.agent(id);
    const since = d.currentSession?.startedAt ?? new Date(Date.now() - 90 * 60_000).toISOString();
    return { session: d.currentSession, transcript: clone(this.sim.events.filter((e) => e.agentId === id && e.ts >= since)) };
  }
  async work(id: string, i: In<typeof WorkInput>) { await wait(); return clone(this.sim.startWork(id, i.title, i.description)); }
  async interrupt(id: string, text: string) {
    await wait();
    const a = this.need(this.sim.agents.get(id), "agent");
    this.sim.event("agent.activity", id, `Interrupt from Mitchell: ${text}`, { activity: "Reading your interrupt" });
    setTimeout(() => this.sim.event("agent.thought", id, `Noted, ${text.length > 40 ? "adjusting course" : `"${text}"`}. I'll fold that into this session.`), 1500);
    void a;
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
    if (/redirect|instead|change|switch/.test(i.message.toLowerCase())) return `I can't change direction from chat. Use Interrupt on the Session tab, or Redirect when you review my report.`;
    if (a.status === "working") return `I'm working on "${asg?.title}". Right now: ${a.activity.toLowerCase()}. I expect to submit a report in a few minutes.`;
    // TODO(web): v1.2 removed the awaiting-review status; the mock's "report waiting" reply went with it
    return `I'm ${a.status} at my desk. My standing direction: ${a.direction.split(":")[0]}. Give me an assignment with Start work and I'll get going.`;
  }
  async stop(id: string) { await wait(); this.sim.patchAgent(id, { status: "stopped", activity: "" }); this.sim.event("agent.status", id, "Stopped by Mitchell"); }

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
  async review(docId: string, i: In<typeof ReviewInput>) { await wait(); return clone(this.sim.review(docId, i.decision, i.note ?? "")); }
  async promote(docId: string, state: DocState) {
    await wait();
    const d = this.need(this.sim.docs.get(docId), "doc");
    d.state = state;
    this.sim.event("doc.state", null, `"${d.title}" moved to the ${state}`, { docId });
    return clone(this.sim.putDoc(d));
  }
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
    const attendees = [...this.sim.agents.values()].filter((a) => a.kind === "resident" && (i.buildingId ? a.homeBuildingId === i.buildingId : true)).map((a) => a.id);
    const m: Meeting = { id: newId("mt"), kind: i.kind, buildingId: i.buildingId, title: i.title || `${i.kind[0].toUpperCase()}${i.kind.slice(1)}`, scheduledAt: i.scheduledAt ?? now(), phase: i.startNow ? "collecting" : "scheduled", facilitatorId: "ag_moss", attendeeIds: attendees, agenda: i.agenda ?? "", summaries: {}, transcript: [], decisions: [], notesDocId: null, createdAt: now(), startedAt: null, endedAt: null };
    this.sim.putMeeting(m);
    this.sim.event("meeting.created", null, `${m.title} ${m.phase === "collecting" ? "is collecting summaries" : "scheduled"}`, { meetingId: m.id }, i.buildingId);
    if (m.phase === "collecting") this.collectSummaries(m);
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
    this.sim.allocations.push({ id: newId("al"), userId: "us_mitchell", buildingId: i.buildingId, tokens: i.tokens, spentTokens: 0, spentUsd: 0, createdAt: now() });
    this.sim.users[0].donatedTokens += i.tokens;
    this.sim.event("allocation.created", null, `Mitchell donated ${(i.tokens / 1e6).toFixed(1)}M tokens`, {}, i.buildingId);
  }
  async budget(): Promise<Budget> {
    await wait();
    const buildings = this.sim.buildings.filter((b) => b.kind !== "town-hall").map((b) => {
      const al = this.sim.allocations.filter((a) => a.buildingId === b.id);
      return { buildingId: b.id, allocated: al.reduce((s, a) => s + a.tokens, 0), spent: al.reduce((s, a) => s + a.spentTokens, 0), spentUsd: al.reduce((s, a) => s + a.spentUsd, 0) };
    });
    return { buildings, users: this.sim.users.map((u) => ({ userId: u.id, name: u.name, donated: u.donatedTokens })) };
  }
  async exportNow() { await wait(400); this.sim.event("export.done", null, "Exported town to git", {}, null); return "a1b2c3d"; }

  connect(h: SocketHandlers): Socket {
    let off: (() => void) | null = null;
    setTimeout(() => h.onOpen(), 30);
    return {
      send: (m) => {
        if (m.type === "auth") {
          setTimeout(() => h.onMessage(this.sim.snapshot()), 40);
          off = (() => { const u = this.sim.subscribe((msg) => h.onMessage(msg)); return () => { u(); }; })();
          if (!this.started) { this.started = true; this.sim.start(); for (const m of this.sim.meetings.values()) if (m.phase === "collecting") this.collectSummaries(m); }
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
