/**
 * Client store: the WS snapshot plus live updates. React reads it with `useTown(selector)`;
 * the canvas renderer reads `store.state` and the mutable `live` maps directly every frame,
 * so 10 Hz position batches never re-render React.
 */
import { useSyncExternalStore } from "react";
import { mapFlagOf, ServerMessage } from "@muster-town/schema";
import type { Agent, Assignment, AuthMe, BlockedAssignment, Doc, ScheduleView, Event, MapFlag, Meeting, Permission, Place, SnapshotBuilding, Town, TownHealth } from "@muster-town/schema";
import type { Bank, Grid, Snapshot } from "./api";
import { redeployStatus, type RedeployLiveAt } from "./redeploy";
import { redirectPanel } from "./panels/room";

/**
 * Every panel is a place: walk up and press E. `intray`/`board`/`cabinet` take a building id; the Town Hall places
 * the old `#/finance` opens it too; its `tab` is the thing in its room you used, BANK_FIXTURES). `admin` is the old name for `planning`.
 * the old `#/finance` opens it too). `admin` is the old name for `planning`.
 * `grant`, `assignment` and `session` are the panels without a place: a grant or proposal (`gr_…`), an assignment card (`as_…`)
 * and a session (`se_…`), reached from any link to its id.
 */
export type PanelKind = "agent" | "building" | "connect" | "library" | "outbox" | "stats" | "meeting" | "intray" | "board" | "cabinet" | "planning" | "schedule" | "mod" | "bank" | "admin" | "grant" | "manual" | "goals" | "assignment" | "session";
export interface PanelRef { kind: PanelKind; id?: string; docId?: string; tab?: string }
interface Toast { id: number; text: string; tone: "info" | "ok" | "bad"; panel?: PanelRef }

interface TownState {
  conn: "connecting" | "open" | "closed";
  me: AuthMe | null;
  town: Town | null;
  /** buildings as the snapshot carries them, with `intray` (pending report count) */
  buildings: SnapshotBuilding[];
  agents: Record<string, Agent>;
  places: Place[];
  /** flags standing on the map (planted, not yet picked up by the manager); the snapshot's, then kept by `doc` frames */
  flags: MapFlag[];
  /** outbox requests nobody has claimed yet: the snapshot's count, then kept by `outbox` frames (the map's outbox badge) */
  outbox: number;
  grid: Grid | null;
  gridVersion: number;
  meetings: Record<string, Meeting>;
  events: Event[];
  docs: Record<string, Doc>;
  assignments: Record<string, Assignment>;
  panel: PanelRef | null;
  toasts: Toast[];
  /** bumps whenever a doc/assignment/meeting arrives so panels can refetch lists */
  rev: number;
  /** `GET /api/bank`, shown on the Bank's sign; null until the first fetch */
  bank: Bank | null;
  /** the snapshot's `health` (docker up?); live changes arrive as `alert` system events */
  health: TownHealth | null;
  /** `GET /api/admin/redeploy`, refetched on each redeploy event; null until fetched (or not served) */
  redeployLive: RedeployLiveAt | null;
  /** `GET /api/blocked`: per agent, its queued assignments that can't start and why (queue rows, the map's blocked badges and red lines) */
  blocked: Record<string, BlockedAssignment[]>;
  /** `GET /api/scheduled`: every building's active schedules, soonest run first (the map's schedule boards) */
  scheduled: ScheduleView[];
}

const MAX_EVENTS = 600;

class Store {
  state: TownState = {
    conn: "connecting", me: null, town: null, buildings: [], agents: {}, places: [], flags: [], outbox: 0, grid: null, gridVersion: 0,
    meetings: {}, events: [], docs: {}, assignments: {}, panel: null, toasts: [], rev: 0, bank: null, health: null, redeployLive: null, blocked: {}, scheduled: [],
  };
  /** Latest server position per agent (tile coords). Mutated in place; the renderer interpolates. */
  readonly livePos = new Map<string, { x: number; y: number; at: number }>();
  /** Recent speech per agent for bubbles. */
  readonly said = new Map<string, { text: string; at: number }>();
  private listeners = new Set<() => void>();
  private toastSeq = 0;
  /** the redeploy event last toasted (finished/failed), so each is announced once */
  private redeployToasted = 0;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  get = () => this.state;
  set(patch: Partial<TownState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get avatarId(): string | null { return this.state.me?.avatarAgentId ?? null; }

  /** Entry point for every WS frame (real or mock). Parsed with the shared schema. */
  receive(raw: unknown) {
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) { console.warn("[web] unparseable server message", parsed.error.issues.slice(0, 3), raw); return; }
    const m = parsed.data;
    const s = this.state;
    switch (m.type) {
      case "snapshot": return this.applySnapshot(m);
      case "agent": {
        if (m.agent.status === "retired") return this.dropAgent(m.agent.id); // dismissed: never drawn
        const prev = s.agents[m.agent.id];
        if (!prev || prev.pos.x !== m.agent.pos.x || prev.pos.y !== m.agent.pos.y) this.livePos.set(m.agent.id, { ...m.agent.pos, at: performance.now() });
        return this.set({ agents: { ...s.agents, [m.agent.id]: m.agent } });
      }
      case "agents.pos": {
        let agents: Record<string, Agent> | null = null;
        const now = performance.now();
        for (const p of m.positions) {
          if (p.id === this.avatarId) continue; // our own body moves client-side
          if (p.status === "retired") { if (s.agents[p.id]) this.dropAgent(p.id); continue; }
          this.livePos.set(p.id, { x: p.x, y: p.y, at: now });
          const a = (agents ?? s.agents)[p.id];
          if (a && a.status !== p.status) {
            agents ??= { ...s.agents };
            agents[p.id] = { ...a, status: p.status };
          }
        }
        if (agents) this.set({ agents });
        return;
      }
      case "event": return this.applyEvent(m.event);
      case "doc": return this.set({ docs: { ...s.docs, [m.doc.id]: m.doc }, ...this.flagsWith([m.doc]), rev: s.rev + 1 });
      case "outbox": return this.set({ outbox: m.open, rev: s.rev + 1 });
      case "meeting": return this.set({ meetings: { ...s.meetings, [m.meeting.id]: m.meeting }, rev: s.rev + 1 });
      case "assignment": {
        this.set({ assignments: { ...s.assignments, [m.assignment.id]: m.assignment }, rev: s.rev + 1 });
        // a queue changed: what blocks whom may have too
        return this.onAssignmentChanged?.();
      }
      case "building": {
        const known = s.buildings.find((b) => b.id === m.building.id);
        // `intray` is resent when reports are created or decided, `budget` when tokens are charged or donated;
        // other building updates may omit them
        const next: SnapshotBuilding = { ...m.building, intray: m.building.intray ?? known?.intray ?? 0, budget: m.building.budget ?? known?.budget, stoplight: m.building.stoplight === undefined ? known?.stoplight : m.building.stoplight };
        const buildings = known ? s.buildings.map((b) => (b.id === m.building.id ? next : b)) : [...s.buildings, next];
        this.set({ buildings, rev: s.rev + 1 });
        // The WS protocol has no grid message: a new building, a moved lot or moved furniture means the layout changed.
        const lotChanged = !known || JSON.stringify(known.lot) !== JSON.stringify(m.building.lot) || JSON.stringify(known.furniture) !== JSON.stringify(m.building.furniture);
        if (lotChanged) this.onLayoutChanged?.();
        // tokens were charged or donated: the Bank's balance may have moved
        if (m.building.budget) this.onBankChanged?.();
        return;
      }
      case "error": return this.toast(m.message, "bad");
    }
  }
  onLayoutChanged?: () => void;
  /** refetch `redeployLive` (set at boot) */
  onRedeployEvent?: () => void;
  /** refetch `bank` (set at boot; throttled there) */
  onBankChanged?: () => void;
  /** refetch `blocked` (set at boot; debounced there) */
  onAssignmentChanged?: () => void;
  /** refetch `me`: an admin decided this person's request to join (set at boot) */
  onAccessDecided?: () => void;

  /** Names of agents that left the snapshot (dismissed, banned) so docs keep a readable author. */
  readonly names = new Map<string, string>();
  private dropAgent(id: string) {
    if (!this.state.agents[id]) return;
    this.names.set(id, this.state.agents[id].name);
    const agents = { ...this.state.agents };
    delete agents[id];
    this.livePos.delete(id);
    this.said.delete(id);
    const panel = this.state.panel?.kind === "agent" && this.state.panel.id === id ? null : this.state.panel;
    this.set({ agents, panel, rev: this.state.rev + 1 });
  }

  applySnapshot(m: Snapshot) {
    const agents: Record<string, Agent> = {};
    this.livePos.clear();
    const now = performance.now();
    for (const a of m.agents) {
      if (a.status === "retired") continue; // the server already omits them; never draw one regardless
      agents[a.id] = a; this.livePos.set(a.id, { ...a.pos, at: now });
    }
    const meetings: Record<string, Meeting> = {};
    for (const mt of m.meetings) meetings[mt.id] = mt;
    this.set({
      town: m.town, buildings: m.buildings, agents, places: m.places, flags: m.flags ?? [], outbox: m.outbox ?? 0, grid: m.grid, meetings, health: m.health ?? this.state.health,
      gridVersion: this.state.gridVersion + 1, rev: this.state.rev + 1,
    });
  }

  applyEvent(e: Event) {
    const s = this.state;
    if (s.events.length && s.events[s.events.length - 1].id >= e.id && s.events.some((x) => x.id === e.id)) return;
    const events = s.events.length >= MAX_EVENTS ? [...s.events.slice(-MAX_EVENTS + 1), e] : [...s.events, e];
    const patch: Partial<TownState> = { events };
    if (e.type === "agent.said" && e.agentId) {
      const text = typeof e.payload.text === "string" ? e.payload.text : e.text;
      this.said.set(e.agentId, { text, at: performance.now() });
    }
    if (e.agentId && (e.type === "agent.activity" || e.type === "agent.tool")) {
      const a = s.agents[e.agentId];
      const text = typeof e.payload.activity === "string" ? e.payload.activity : e.text;
      if (a && a.activity !== text) patch.agents = { ...s.agents, [a.id]: { ...a, activity: text } };
    }
    // key results and grants are read on demand (the board, building settings), so their events bump `rev`
    if (e.type.startsWith("kr.") || e.type.startsWith("grant.") || e.type === "building.blocked") patch.rev = s.rev + 1;
    this.set(patch);
    if (e.type.startsWith("bank.")) this.onBankChanged?.();
    // a grant decided or a building blocked/unblocked moves lane holds
    if (e.type.startsWith("grant.") || e.type === "building.blocked") this.onAssignmentChanged?.();
    if (e.type === "system" && e.payload.redeploy) this.onRedeployEvent?.();
    if (isMyAccessDecision(e, s.me?.user.id)) this.onAccessDecided?.();
    this.toastRedeploy();
    // a message addressed to the human's avatar
    const me = this.avatarId;
    const to = e.payload.toId ?? e.payload.to;
    const viewing = s.panel?.kind === "agent" && s.panel.id === e.agentId;
    if (e.type === "agent.told" && me && to === me && !viewing) {
      const from = e.agentId ? s.agents[e.agentId]?.name ?? "Someone" : "Someone";
      const body = typeof e.payload.text === "string" ? e.payload.text : e.text;
      this.toast(`${from}: ${body}`, "info", e.agentId ? { kind: "agent", id: e.agentId, tab: "Talk" } : undefined);
    }
  }

  mergeEvents(list: Event[]) {
    if (!list.length) return;
    const byId = new Map(this.state.events.map((e) => [e.id, e]));
    for (const e of list) byId.set(e.id, e);
    const events = [...byId.values()].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS);
    this.set({ events });
    if (list.some((e) => e.type === "system" && e.payload.redeploy)) this.onRedeployEvent?.();
    // missed while the socket was down (a refetch after reconnect): the refetch of `me` only toasts on a real change
    if (list.some((e) => isMyAccessDecision(e, this.state.me?.user.id))) this.onAccessDecided?.();
    this.toastRedeploy();
  }
  /** A redeploy that just finished or failed gets a toast (also when its event arrives in a refetch after the restart). */
  private toastRedeploy() {
    const r = redeployStatus(this.state.events);
    if (!r || r.eventId <= this.redeployToasted || (r.state !== "done" && r.state !== "failed")) return;
    this.redeployToasted = r.eventId;
    if (Date.now() - r.at > 2 * 60_000) return;
    this.toast(r.state === "done" ? r.text : `${r.text}. Open the planning desk for the log.`, r.state === "done" ? "ok" : "bad", { kind: "planning", tab: "System" });
  }
  putDocs(list: Doc[]) {
    if (!list.length) return;
    const docs = { ...this.state.docs };
    for (const d of list) docs[d.id] = d;
    this.set({ docs, ...this.flagsWith(list) });
  }
  /** A doc was deleted (a moderator removed an outbox request): forget it and let lists refetch. */
  dropDoc(id: string) {
    const docs = { ...this.state.docs };
    delete docs[id];
    this.set({ docs, rev: this.state.rev + 1 });
  }
  /** `flags` after these docs changed: a flag doc stands on the map while it is pending and not picked up. */
  private flagsWith(list: Doc[]): Partial<TownState> {
    if (!list.some((d) => d.type === "flag")) return {};
    const ids = new Set(list.map((d) => d.id));
    const flags = this.state.flags.filter((f) => !ids.has(f.docId));
    for (const d of list) { const f = mapFlagOf(d); if (f) flags.push(f); }
    return { flags };
  }
  putAssignments(list: Assignment[]) {
    if (!list.length) return;
    const assignments = { ...this.state.assignments };
    for (const a of list) assignments[a.id] = a;
    this.set({ assignments });
  }
  putMeeting(m: Meeting) { this.set({ meetings: { ...this.state.meetings, [m.id]: m } }); }

  /** Always a fresh ref, so re-opening a panel that's already open (e.g. E twice on one target) counts as a new open (app.tsx openSeq). */
  open(panel: PanelRef | null) { const p = redirectPanel(panel); this.set({ panel: p ? { ...p } : null }); }
  /** Walk the avatar to a place (animated when a path exists, else teleport), then open `panel`. Set by the map. */
  walkTo: (placeId: string, panel?: PanelRef) => boolean = () => false;
  toast(text: string, tone: Toast["tone"] = "info", panel?: PanelRef) {
    const t: Toast = { id: ++this.toastSeq, text, tone, panel };
    this.set({ toasts: [...this.state.toasts.slice(-3), t] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) }), 6000);
  }

  /** Discord-style check against the roles in AuthMe. */
  can(perm: Permission, buildingId?: string | null): boolean {
    const me = this.state.me;
    if (!me) return false;
    if (me.isAdmin) return true;
    return me.roles.some((r) => r.permissions.includes(perm) && (r.scope === "town" || (!!buildingId && r.buildingId === buildingId)));
  }
}

export const store = new Store();

/**
 * An admin let this signed-in person in, or declined them (core decideAccess's `system` event, payload
 * `{ accessRequestId, userId, granted }`; the ask itself has no `granted`). Every socket gets the event, so the
 * requester's page refetches `me` instead of waiting for a reload (flag dc_1kylouq1l7).
 */
export function isMyAccessDecision(e: Event, userId: string | undefined): boolean {
  return !!userId && e.type === "system" && !!e.payload.accessRequestId && e.payload.userId === userId && typeof e.payload.granted === "boolean";
}

/**
 * The toast for a change in `me` after a decision, or null when nothing changed (a stale event, a refetch of the same
 * state). Being let in has no toast: the HUD's one-time "You're in" card says it, live or on the next visit (youreIn.ts).
 */
export function accessDecisionToast(before: AuthMe | null, after: AuthMe): { text: string; tone: "ok" | "info" } | null {
  if (before?.accessRequest?.status === "pending" && after.accessRequest?.status === "declined") return { text: "Your request to join was declined this time. You can ask again tomorrow.", tone: "info" };
  return null;
}
// dev and mock builds only: lets a browser check (or a curious dev) open panels from the console, e.g. __muster.open({ kind: "agent", id })
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __muster?: Store }).__muster = store;

export function useTown<T>(selector: (s: TownState) => T): T {
  const get = () => selector(store.state);
  return useSyncExternalStore(store.subscribe, get, get); // the server snapshot is the same store (static renders in tests)
}

/** True when `a` is the manager its home building's settings name. */
export function isManager(a: Pick<Agent, "id" | "homeBuildingId">, buildings: SnapshotBuilding[] = store.state.buildings): boolean {
  return !!a.homeBuildingId && buildings.some((b) => b.id === a.homeBuildingId && b.managerAgentId === a.id);
}

/** The label next to an agent's name: service agents keep theirs ("Librarian"); a building's manager reads "Manager"; other residents have none. */
export const roleOf = (a: Pick<Agent, "id" | "kind" | "title" | "homeBuildingId">): string => (a.kind === "service" ? a.title : isManager(a) ? "Manager" : "");
