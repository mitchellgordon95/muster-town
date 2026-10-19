import {
  Agent, Allocation, Assignment, Building, Doc, Meeting, Membership, Message, Place, Role, Session, Town, User,
  type ServerMessage,
} from "@agent-town/schema";
import type { DB } from "./db.ts";
import { Table } from "./table.ts";
import { Emitter, newToken, nowIso } from "./util.ts";

export type TokenKind = "user" | "agent";
export interface TokenRow { token: string; kind: TokenKind; id: string; createdAt: string }

export class Memberships {
  constructor(private db: DB) {}
  add(m: Membership): void {
    this.db.prepare("INSERT OR IGNORE INTO memberships (roleId, holderKind, holderId) VALUES (?, ?, ?)")
      .run(m.roleId, m.holderKind, m.holderId);
  }
  remove(m: Membership): void {
    this.db.prepare("DELETE FROM memberships WHERE roleId = ? AND holderKind = ? AND holderId = ?")
      .run(m.roleId, m.holderKind, m.holderId);
  }
  forHolder(holderKind: "agent" | "user", holderId: string): Membership[] {
    return this.db.prepare("SELECT * FROM memberships WHERE holderKind = ? AND holderId = ?").all(holderKind, holderId) as Membership[];
  }
  forRole(roleId: string): Membership[] {
    return this.db.prepare("SELECT * FROM memberships WHERE roleId = ?").all(roleId) as Membership[];
  }
  list(): Membership[] {
    return this.db.prepare("SELECT * FROM memberships ORDER BY rowid").all() as Membership[];
  }
}

export class Tokens {
  constructor(private db: DB) {}
  create(kind: TokenKind, id: string): string {
    const token = newToken();
    this.db.prepare("INSERT INTO tokens (token, kind, id, createdAt) VALUES (?, ?, ?, ?)").run(token, kind, id, nowIso());
    return token;
  }
  /** Existing token for this holder, or a new one. */
  getOrCreate(kind: TokenKind, id: string): string {
    const row = this.db.prepare("SELECT token FROM tokens WHERE kind = ? AND id = ? ORDER BY createdAt LIMIT 1").get(kind, id) as { token: string } | undefined;
    return row?.token ?? this.create(kind, id);
  }
  resolve(token: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE token = ?").get(token) as TokenRow | undefined;
  }
  revoke(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
  }
}

/** Users table plus the secret apiKey column that is never part of the User object. */
export class Users extends Table<User> {
  constructor(private readonly rawDb: DB, onChange?: (u: User) => void) {
    super(rawDb, "users", User, { bool: ["hasApiKey"] }, onChange);
  }
  setApiKey(userId: string, apiKey: string | null): User {
    this.rawDb.prepare("UPDATE users SET apiKey = ?, hasApiKey = ? WHERE id = ?").run(apiKey, apiKey ? 1 : 0, userId);
    return this.require(userId);
  }
  /** Secret. Only the runtime should call this (to set ANTHROPIC_API_KEY for a session). */
  getApiKey(userId: string): string | null {
    const r = this.rawDb.prepare("SELECT apiKey FROM users WHERE id = ?").get(userId) as { apiKey: string | null } | undefined;
    return r?.apiKey ?? null;
  }
}

export class TownMeta {
  constructor(private db: DB, private onChange?: (t: Town) => void) {}
  get(): Town {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'town'").get() as { value: string } | undefined;
    return Town.parse(r ? JSON.parse(r.value) : { name: "Agent Town", goal: "" });
  }
  set(t: Partial<Town>): Town {
    const town = Town.parse({ ...this.get(), ...t });
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('town', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(town));
    this.onChange?.(town);
    return town;
  }
  isSet(): boolean {
    return !!this.db.prepare("SELECT 1 FROM meta WHERE key = 'town'").get();
  }
}

/** All repositories. Writes to agents/docs/meetings/buildings/assignments emit the matching ServerMessage. */
export function createRepos(db: DB, changes: Emitter<ServerMessage>) {
  return {
    users: new Users(db),
    roles: new Table<Role>(db, "roles", Role, { json: ["permissions"], bool: ["builtin"] }),
    memberships: new Memberships(db),
    buildings: new Table<Building>(db, "buildings", Building, { json: ["meetings", "lot"] }, (building) => changes.emit({ type: "building", building })),
    allocations: new Table<Allocation>(db, "allocations", Allocation),
    agents: new Table<Agent>(db, "agents", Agent, { json: ["pos"] }, (agent) => changes.emit({ type: "agent", agent })),
    places: new Table<Place>(db, "places", Place, { json: ["pos"] }),
    docs: new Table<Doc>(db, "docs", Doc, { json: ["provenance", "tags"] }, (doc) => changes.emit({ type: "doc", doc })),
    assignments: new Table<Assignment>(db, "assignments", Assignment, {}, (assignment) => changes.emit({ type: "assignment", assignment })),
    messages: new Table<Message>(db, "messages", Message),
    meetings: new Table<Meeting>(db, "meetings", Meeting, { json: ["attendeeIds", "summaries", "transcript", "decisions"] }, (meeting) => changes.emit({ type: "meeting", meeting })),
    sessions: new Table<Session>(db, "sessions", Session),
    tokens: new Tokens(db),
    town: new TownMeta(db),
  };
}
export type Repos = ReturnType<typeof createRepos>;
