import { Event, type ServerMessage } from "@muster-town/schema";
import type { DB } from "./db.ts";
import { whereOf } from "./table.ts";
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
  /** only events at or after this ISO time */
  from?: string;
  /** only events whose text matches this SQL LIKE pattern */
  textLike?: string;
  /** only events whose payload has this key set (not null) */
  payloadKey?: string;
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
    const where = whereOf({ agentId: q.agentId, buildingId: q.buildingId, type: q.types?.length ? q.types : undefined }, [
      q.since !== undefined && { sql: "id > ?", params: [q.since] },
      q.from && { sql: "ts >= ?", params: [q.from] },
      q.textLike && { sql: "text LIKE ?", params: [q.textLike] },
      q.payloadKey && { sql: "json_extract(payload, ?) IS NOT NULL", params: [`$.${q.payloadKey}`] },
    ]);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 5000);
    const sql = `SELECT * FROM events ${where.sql ? "WHERE " + where.sql : ""} ORDER BY id ${q.desc ? "DESC" : "ASC"} LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...where.params) as Record<string, unknown>[];
    return rows.map((r) => Event.parse({ ...r, payload: JSON.parse(String(r.payload ?? "{}")) }));
  }

  /** The latest `limit` events, returned oldest first. */
  recent(q: Omit<EventQuery, "desc"> = {}): Event[] {
    return this.list({ ...q, desc: true }).reverse();
  }

  /** The newest event of `type` whose payload has `key` (set, not null), optionally one of `values`. */
  latestWith(type: EventType, key: string, values?: unknown[]): Event | undefined {
    const path = `$.${key}`;
    const vals = values?.length ? ` AND json_extract(payload, ?) IN (${values.map(() => "?").join(",")})` : "";
    const r = this.db.prepare(`SELECT * FROM events WHERE type = ? AND json_extract(payload, ?) IS NOT NULL${vals} ORDER BY id DESC LIMIT 1`)
      .get(type, path, ...(values?.length ? [path, ...values] : [])) as Record<string, unknown> | undefined;
    return r ? Event.parse({ ...r, payload: JSON.parse(String(r.payload ?? "{}")) }) : undefined;
  }

  lastId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null };
    return r.id ?? 0;
  }
}
