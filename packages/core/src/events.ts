import { Event, type ServerMessage } from "@muster-town/schema";
import type { DB } from "./db.ts";
import { Emitter, nowIso } from "./util.ts";

export type EventType = Event["type"];
export interface NewEvent {
  type: EventType;
  text: string;
  agentId?: string | null;
  buildingId?: string | null;
  payload?: Record<string, unknown>;
}
export interface EventQuery {
  since?: number;
  agentId?: string;
  buildingId?: string;
  types?: EventType[];
  limit?: number;
  /** newest first instead of oldest first */
  desc?: boolean;
}

/** Append-only activity log. `append` stores, then notifies subscribers synchronously. */
export class EventLog {
  private emitter = new Emitter<Event>();
  private hooks: ((e: Event) => void)[] = [];
  constructor(private db: DB, private changes: Emitter<ServerMessage>) {}

  append(e: NewEvent): Event {
    const ts = nowIso();
    const payload = e.payload ?? {};
    const info = this.db.prepare("INSERT INTO events (ts, type, agentId, buildingId, text, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ts, e.type, e.agentId ?? null, e.buildingId ?? null, e.text, JSON.stringify(payload));
    const event = Event.parse({ id: Number(info.lastInsertRowid), ts, type: e.type, agentId: e.agentId ?? null, buildingId: e.buildingId ?? null, text: e.text, payload });
    for (const h of this.hooks) h(event);
    this.emitter.emit(event);
    this.changes.emit({ type: "event", event });
    return event;
  }

  subscribe(fn: (e: Event) => void): () => void {
    return this.emitter.subscribe(fn);
  }

  /** internal: world-maintained side effects (e.g. agent.activity) */
  addHook(fn: (e: Event) => void): void {
    this.hooks.push(fn);
  }

  list(q: EventQuery = {}): Event[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.since !== undefined) { where.push("id > ?"); params.push(q.since); }
    if (q.agentId) { where.push("agentId = ?"); params.push(q.agentId); }
    if (q.buildingId) { where.push("buildingId = ?"); params.push(q.buildingId); }
    if (q.types?.length) { where.push(`type IN (${q.types.map(() => "?").join(",")})`); params.push(...q.types); }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 5000);
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ${q.desc ? "DESC" : "ASC"} LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => Event.parse({ ...r, payload: JSON.parse(String(r.payload ?? "{}")) }));
  }

  /** The latest `limit` events, returned oldest first. */
  recent(q: Omit<EventQuery, "desc"> = {}): Event[] {
    return this.list({ ...q, desc: true }).reverse();
  }

  lastId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null };
    return r.id ?? 0;
  }
}
