/**
 * Typed client for the Agent Town server (REST + WS). The same `Api` interface is
 * implemented by `mock/server.ts` so the whole UI runs without a backend (VITE_MOCK=1).
 */
import type { z } from "zod";
import type {
  Agent, Assignment, AuthMe, Building, ClientMessage, Doc, Event, Meeting, Place, Role, Membership,
  ServerMessage, Session, Town, CreateBuildingInput, UpdateBuildingInput, CreateResidentInput,
  ReviewInput, ChatInput, WorkInput, DonateInput, CreateMeetingInput, DocState, DocType,
} from "@agent-town/schema";

export type In<T extends z.ZodTypeAny> = z.input<T>;
export type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;
export type Grid = Snapshot["grid"];

export interface AgentDetail {
  agent: Agent;
  recentEvents: Event[];
  currentSession: Session | null;
  latestReport: Doc | null;
  assignments: Assignment[];
}
export interface DocQuery { state?: DocState; type?: DocType; buildingId?: string; q?: string; limit?: number }
export interface EventQuery { since?: number; agentId?: string; buildingId?: string; limit?: number }
/** `GET /api/budget` — the contract only says "per-building allocated/spent and per-user donated". */
export interface Budget {
  buildings: { buildingId: string; allocated: number; spent: number; spentUsd?: number; spentTodayTokens?: number }[];
  users: { userId: string; name?: string; donated: number }[];
}
export interface WriteDocInput { type?: DocType; title: string; body: string; state?: "draft" | "building"; tags?: string[] }
export type RequestAction = "approve" | "reject" | "claim" | "done";

export interface Socket { send(msg: ClientMessage): void; close(): void }
export interface SocketHandlers { onMessage(msg: unknown): void; onOpen(): void; onClose(): void }

export interface Api {
  readonly mock: boolean;
  devAdminToken(): Promise<string | null>;
  me(): Promise<AuthMe>;
  town(): Promise<Snapshot>;
  events(q: EventQuery): Promise<Event[]>;
  // buildings
  board(buildingId: string, limit?: number): Promise<Doc[]>;
  cabinet(buildingId: string, limit?: number): Promise<Doc[]>;
  createBuilding(input: In<typeof CreateBuildingInput>): Promise<Building>;
  updateBuilding(id: string, input: In<typeof UpdateBuildingInput>): Promise<Building>;
  // agents
  /** pending reports for the building's in-tray, oldest first */
  intray(buildingId: string): Promise<Doc[]>;
  createResident(input: In<typeof CreateResidentInput>): Promise<Agent>;
  /** DELETE /api/agents/:id — dismiss (retire) a resident; purge also deletes its desk volume */
  dismiss(id: string, purge?: boolean): Promise<void>;
  /** town.ban */
  ban(id: string, reason: string): Promise<Agent>;
  agent(id: string): Promise<AgentDetail>;
  session(id: string): Promise<{ session: Session | null; transcript: Event[] }>;
  work(id: string, input: In<typeof WorkInput>): Promise<Assignment | null>;
  interrupt(id: string, text: string): Promise<void>;
  chat(id: string, input: In<typeof ChatInput>): Promise<string>;
  stop(id: string): Promise<void>;
  // docs
  docs(q: DocQuery): Promise<Doc[]>;
  doc(id: string): Promise<Doc>;
  writeDoc(input: WriteDocInput): Promise<Doc>;
  review(docId: string, input: In<typeof ReviewInput>): Promise<Doc>;
  /** POST /api/docs/:id/reply — the reply becomes the author's next assignment; empty text archives */
  reply(docId: string, text: string): Promise<{ doc: Doc; assignment: Assignment | null }>;
  /** POST /api/docs/:id/archive — acknowledge with no reply */
  archive(docId: string): Promise<{ doc: Doc; assignment: Assignment | null }>;
  /** POST /api/docs/:id/ask — a cheap-model answer about the report, without its author */
  ask(docId: string, question: string, history?: { role: "user" | "assistant"; text: string }[]): Promise<string>;
  promote(docId: string, state: DocState): Promise<Doc>;
  trophy(docId: string, approve: boolean): Promise<Doc>;
  request(docId: string, action: RequestAction, body?: string): Promise<Doc>;
  // meetings
  meetings(q: { buildingId?: string; phase?: string }): Promise<Meeting[]>;
  createMeeting(input: In<typeof CreateMeetingInput>): Promise<Meeting>;
  meeting(id: string): Promise<Meeting>;
  startMeeting(id: string): Promise<Meeting>;
  sayMeeting(id: string, text: string): Promise<Meeting>;
  endMeeting(id: string): Promise<Meeting>;
  // roles, budget, export
  roles(buildingId?: string): Promise<{ roles: Role[]; memberships: Membership[] }>;
  assignRole(m: Membership): Promise<void>;
  unassignRole(m: Membership): Promise<void>;
  donate(input: In<typeof DonateInput>): Promise<void>;
  budget(): Promise<Budget>;
  exportNow(): Promise<string | null>;
  connect(handlers: SocketHandlers): Socket;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

const TOKEN_KEY = "agentTown.token";
export const tokenStore = {
  get(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t: string | null) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

/** Single-object endpoints aren't pinned down in the contract: accept `{doc}` or the bare object. */
function unwrap<T>(r: unknown, key: string): T {
  if (r && typeof r === "object" && key in (r as Record<string, unknown>)) return (r as Record<string, T>)[key];
  return r as T;
}
function qs(q: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export class HttpApi implements Api {
  readonly mock = false;
  constructor(private token: () => string | null) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const t = this.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; code?: string };
      throw new ApiError(e.error ?? `${res.status} ${res.statusText}`, e.code ?? "http", res.status);
    }
    return json as T;
  }
  private get<T>(p: string) { return this.call<T>("GET", p); }
  private post<T>(p: string, b: unknown = {}) { return this.call<T>("POST", p, b); }

  async devAdminToken() {
    try {
      const r = await this.get<unknown>("/api/dev/admin-token");
      if (typeof r === "string") return r.trim() || null;
      return unwrap<string>(r, "token") ?? null;
    } catch { return null; }
  }
  me() { return this.get<AuthMe>("/api/me"); }
  async town() { return { type: "snapshot", ...(await this.get<Omit<Snapshot, "type">>("/api/town")) } as Snapshot; }
  async events(q: EventQuery) { return unwrap<Event[]>(await this.get(`/api/events${qs(q)}`), "events"); }
  async board(id: string, limit = 30) { return unwrap<Doc[]>(await this.get(`/api/buildings/${id}/board${qs({ limit })}`), "docs"); }
  async cabinet(id: string, limit = 30) { return unwrap<Doc[]>(await this.get(`/api/buildings/${id}/cabinet${qs({ limit })}`), "docs"); }
  async createBuilding(i: In<typeof CreateBuildingInput>) { return unwrap<Building>(await this.post("/api/buildings", i), "building"); }
  async updateBuilding(id: string, i: In<typeof UpdateBuildingInput>) { return unwrap<Building>(await this.call("PATCH", `/api/buildings/${id}`, i), "building"); }
  async intray(id: string) { return unwrap<Doc[]>(await this.get(`/api/buildings/${id}/intray`), "reports"); }
  async createResident(i: In<typeof CreateResidentInput>) { return unwrap<Agent>(await this.post("/api/agents/residents", i), "agent"); }
  async dismiss(id: string, purge = false) { await this.call("DELETE", `/api/agents/${id}${purge ? "?purge=1" : ""}`); }
  async ban(id: string, reason: string) { return unwrap<Agent>(await this.post(`/api/agents/${id}/ban`, { reason }), "agent"); }
  agent(id: string) { return this.get<AgentDetail>(`/api/agents/${id}`); }
  session(id: string) { return this.get<{ session: Session | null; transcript: Event[] }>(`/api/agents/${id}/session`); }
  async work(id: string, i: In<typeof WorkInput>) { return unwrap<Assignment | null>(await this.post(`/api/agents/${id}/work`, i), "assignment"); }
  async interrupt(id: string, text: string) { await this.post(`/api/agents/${id}/interrupt`, { text }); }
  async chat(id: string, i: In<typeof ChatInput>) { return (await this.post<{ reply: string }>(`/api/agents/${id}/chat`, i)).reply; }
  async stop(id: string) { await this.post(`/api/agents/${id}/stop`); }
  async docs(q: DocQuery) { return unwrap<Doc[]>(await this.get(`/api/docs${qs(q)}`), "docs"); }
  async doc(id: string) { return unwrap<Doc>(await this.get(`/api/docs/${id}`), "doc"); }
  async writeDoc(i: WriteDocInput) { return unwrap<Doc>(await this.post("/api/docs", i), "doc"); }
  async review(id: string, i: In<typeof ReviewInput>) { return unwrap<Doc>(await this.post(`/api/docs/${id}/review`, i), "doc"); }
  reply(id: string, text: string) { return this.post<{ doc: Doc; assignment: Assignment | null }>(`/api/docs/${id}/reply`, { text }); }
  archive(id: string) { return this.post<{ doc: Doc; assignment: Assignment | null }>(`/api/docs/${id}/archive`); }
  async ask(id: string, question: string, history: { role: "user" | "assistant"; text: string }[] = []) { return (await this.post<{ reply: string }>(`/api/docs/${id}/ask`, { question, history })).reply; }
  async promote(id: string, state: DocState) { return unwrap<Doc>(await this.post(`/api/docs/${id}/promote`, { state }), "doc"); }
  async trophy(id: string, approve: boolean) { return unwrap<Doc>(await this.post(`/api/docs/${id}/trophy`, { approve }), "doc"); }
  async request(id: string, action: RequestAction, body?: string) { return unwrap<Doc>(await this.post(`/api/docs/${id}/request`, { action, body }), "doc"); }
  async meetings(q: { buildingId?: string; phase?: string }) { return unwrap<Meeting[]>(await this.get(`/api/meetings${qs(q)}`), "meetings"); }
  async createMeeting(i: In<typeof CreateMeetingInput>) { return unwrap<Meeting>(await this.post("/api/meetings", i), "meeting"); }
  async meeting(id: string) { return unwrap<Meeting>(await this.get(`/api/meetings/${id}`), "meeting"); }
  async startMeeting(id: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/start`), "meeting"); }
  async sayMeeting(id: string, text: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/say`, { text }), "meeting"); }
  async endMeeting(id: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/end`), "meeting"); }
  async roles(buildingId?: string) {
    const r = await this.get<{ roles?: Role[]; memberships?: Membership[] } | Role[]>(`/api/roles${qs({ buildingId })}`);
    return Array.isArray(r) ? { roles: r, memberships: [] } : { roles: r.roles ?? [], memberships: r.memberships ?? [] };
  }
  async assignRole(m: Membership) { await this.post("/api/roles/assign", m); }
  async unassignRole(m: Membership) { await this.call("DELETE", "/api/roles/assign", m); }
  async donate(i: In<typeof DonateInput>) { await this.post("/api/donate", i); }
  async budget() {
    const r = await this.get<Partial<Budget>>("/api/budget");
    return { buildings: r.buildings ?? [], users: r.users ?? [] };
  }
  async exportNow() { return (await this.post<{ commit?: string | null }>("/api/export")).commit ?? null; }

  connect(h: SocketHandlers): Socket {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.onopen = () => h.onOpen();
    ws.onclose = () => h.onClose();
    ws.onmessage = (e) => { try { h.onMessage(JSON.parse(String(e.data))); } catch (err) { console.warn("[web] bad ws frame", err); } };
    return {
      send: (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
      close: () => ws.close(),
    };
  }
}

export const isMock = import.meta.env.VITE_MOCK === "1";

let instance: Api | null = null;
export async function getApi(): Promise<Api> {
  if (instance) return instance;
  if (isMock) {
    const { MockApi } = await import("./mock/server");
    instance = new MockApi();
  } else {
    instance = new HttpApi(() => tokenStore.get());
  }
  return instance;
}
/** Synchronous accessor for components; valid after boot. */
export function api(): Api {
  if (!instance) throw new Error("api not initialised");
  return instance;
}

export type { Town, Place };
