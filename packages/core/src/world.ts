import { townEnv, type Agent, type AgentStatus, type DesksConfig, type RedeployLive, type RedeployResult, type ServerMessage, type Tile } from "@muster-town/schema";
import { Bank } from "./bank.ts";
import { Budget } from "./budget.ts";
import { Grants } from "./grants.ts";
import { laneHold } from "./lanes.ts";
import { intrayCount, intrayCounts, isTownHallItem } from "./domain.ts";
import { migrateRoles } from "./migrate-roles.ts";
import { openDb, type DB } from "./db.ts";
import { EventLog } from "./events.ts";
import { exportWorld, importExport, type ExportResult } from "./export.ts";
import { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
import { Ops } from "./ops.ts";
import { holderOf, Permissions, type Holder } from "./permissions.ts";
import { Presence } from "./presence.ts";
import { Secrets } from "./secrets.ts";
import { Skills } from "./skills.ts";
import { seedDefaults, type SeedOptions, type SeedResult } from "./seed.ts";
import { createRepos, type Repos } from "./store.ts";
import { Emitter } from "./util.ts";
import { makeVerbs, type Verbs } from "./verbs/index.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import { WorldMap } from "./world/map.ts";
import { Movement } from "./world/movement.ts";

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;

/** Host-side hooks the runtime fills in; core verbs call them when present. */
export interface HostHooks {
  /** Pull main, reinstall, rebuild, restart (runtime/redeploy.ts). A request while one runs joins it: `{ queued: true }`. */
  redeploy?(o: { image: boolean; requestedBy: string }): Promise<RedeployResult> | RedeployResult;
  /** Whether the agent has a live (or starting) work session. Without it, a running work Session row counts. */
  isWorking?(agentId: string): boolean;
  /** Hand `text` to the agent's in-process session. False = not in-process (the caller queues it for a desk). */
  interrupt?(agentId: string, text: string, from?: string, now?: boolean): boolean;
  /** The git commit the running server started from (live code), set by the runtime. Unset without one. */
  commit?: string;
  /** When the runtime started (ISO): a `{deploy: "next"}` wait holds once this is after the assignment was made. */
  startedAt?: string;
  /** Whether the live commit contains `sha` (`git merge-base --is-ancestor`). Without it, `deploy` waits never hold. */
  isLive?(sha: string): boolean;
  /** The runtime's live redeploy state (`GET /api/admin/redeploy`). */
  redeployStatus?(): RedeployLive;
  /** The runtime's last docker probe: false while docker is down (code desks can't start). Unset = not probed. */
  docker?: boolean;
  /** Work-session slots: live or starting sessions out of `desks.maxRunning`. Unset without a runtime. */
  slots?(): { running: number; max: number };
}

export class World {
  readonly db: DB;
  /** Every live change as a WS ServerMessage: event, agent, agents.pos, doc, meeting, building, assignment. */
  readonly changes = new Emitter<ServerMessage>();
  readonly events: EventLog;
  readonly permissions: Permissions;
  readonly budget: Budget;
  readonly bank: Bank;
  /** goal-directed budgets: proposals, grants, key results, exploration allowance */
  readonly grantDesk: Grants;
  /** skills: SKILL.md docs, bundled files, pins, usage (docs/skills.md) */
  readonly skills: Skills;
  /** collective secrets: encrypted values and their grants (docs/secrets.md) */
  readonly secrets: Secrets;
  readonly layout: WorldMap;
  readonly movement: Movement;
  readonly verbs: Verbs;
  readonly ops: Ops;
  /** v1.4 visitor presence: lastSeenAt stamps, offline sweep, mailbox digest, offer expiry */
  readonly presence: Presence;
  /** Host-side actions the runtime registers at start (verbs that need the host, e.g. `redeploy`). Empty without a runtime. */
  readonly host: HostHooks = {};

  // repositories
  readonly users: Repos["users"];
  readonly roles: Repos["roles"];
  readonly memberships: Repos["memberships"];
  readonly buildings: Repos["buildings"];
  readonly allocations: Repos["allocations"];
  readonly agents: Repos["agents"];
  readonly places: Repos["places"];
  readonly docs: Repos["docs"];
  readonly assignments: Repos["assignments"];
  readonly messages: Repos["messages"];
  readonly meetings: Repos["meetings"];
  readonly sessions: Repos["sessions"];
  readonly interrupts: Repos["interrupts"];
  readonly grants: Repos["grants"];
  readonly keyResults: Repos["keyResults"];
  readonly skillPins: Repos["skillPins"];
  readonly tokens: Repos["tokens"];
  readonly town: Repos["town"];

  private clock: ReturnType<typeof setInterval> | null = null;

  /** Open (or create) the town database at `dbPath` (":memory:" works) and build the layout. */
  static open(dbPath: string): World {
    return new World(openDb(dbPath));
  }

  constructor(db: DB) {
    this.db = db;
    // v1.2 roles split: data fix on every open (idempotent), before any role is parsed through the schema
    migrateRoles(db);
    const repos = createRepos(db, this.changes);
    this.users = repos.users; this.roles = repos.roles; this.memberships = repos.memberships;
    this.buildings = repos.buildings; this.allocations = repos.allocations; this.agents = repos.agents;
    this.places = repos.places; this.docs = repos.docs; this.assignments = repos.assignments;
    this.messages = repos.messages; this.meetings = repos.meetings; this.sessions = repos.sessions;
    this.interrupts = repos.interrupts;
    this.grants = repos.grants; this.keyResults = repos.keyResults; this.skillPins = repos.skillPins;
    this.tokens = repos.tokens; this.town = repos.town;
    this.events = new EventLog(db, this.changes);
    this.permissions = new Permissions(repos);
    this.bank = new Bank(repos, this.events, this.permissions);
    this.budget = new Budget(repos, this.events, this.bank, this.changes);
    this.layout = new WorldMap(db, repos);
    this.movement = new Movement(repos, this.layout, this.events, this.changes);
    this.verbs = makeVerbs(this);
    this.ops = new Ops(this);
    this.grantDesk = new Grants(this);
    this.budget.gate = (a) => laneHold(this, a);
    this.budget.afterCharge = (bid) => this.grantDesk.checkpoints(bid);
    this.skills = new Skills(this);
    this.secrets = new Secrets(this);
    this.presence = new Presence(this);
    // agent.activity is server-maintained from events
    this.events.addHook((e) => {
      if (!e.agentId || (e.type !== "agent.activity" && e.type !== "agent.tool")) return;
      const a = this.agents.get(e.agentId);
      if (a) this.agents.upsert({ ...a, activity: e.text, lastActiveAt: e.ts });
    });
    // in-tray badge: a report arrived or was decided, or a grant moved → resend the building with its count;
    // a manager's report and every grant change also resend the Town Hall, whose in-tray they land in
    this.events.addHook((e) => {
      const p = e.payload as Record<string, unknown>;
      const report = (e.type === "doc.created" && p.docType === "report") || e.type === "doc.decision";
      const grant = e.type.startsWith("grant.");
      if (!(report || grant) || !e.buildingId) return;
      const b = this.buildings.get(e.buildingId);
      if (b) this.changes.emit({ type: "building", building: { ...b, intray: intrayCount(this, b.id) } });
      const doc = report && typeof p.docId === "string" ? this.docs.get(p.docId) : undefined;
      const th = grant || (doc && isTownHallItem(this, doc)) ? this.buildings.first("kind = 'town-hall'") : undefined;
      if (th && th.id !== b?.id) this.changes.emit({ type: "building", building: { ...th, intray: intrayCount(this, th.id) } });
    });
    // goal-directed: a grant, key-result or budget-settings change may block or unblock the building (wakes its manager once)
    this.events.addHook((e) => {
      if (!e.buildingId || !(e.type.startsWith("grant.") || e.type === "kr.created" || e.type === "kr.deleted" || e.type === "building.updated")) return;
      this.grantDesk.syncBlocked(e.buildingId);
    });
    this.layout.rebuild();
  }

  /** collective.json `desks` as stored at seed (defaults: backend auto, image muster-town-desk, ghToken gh-cli). */
  desksConfig(): DesksConfig {
    return this.town.desks();
  }
  /** Change the live host settings (`PUT /api/town/desks`); the scheduler reads them on every pass. */
  setDesksConfig(patch: Partial<DesksConfig>): DesksConfig {
    const desks = this.town.setDesks({ ...this.town.desks(), ...patch });
    this.events.append({ type: "system", text: `Session slots set to ${desks.maxRunning}`, payload: { desks: true, maxRunning: desks.maxRunning } });
    return desks;
  }

  /** Run `fn` in one SQLite transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  holderOf(agent: Agent): Holder {
    return holderOf(agent);
  }

  /** Display name for an agent or user id. */
  nameOf(id: string): string {
    return this.agents.get(id)?.name ?? this.users.get(id)?.name ?? id;
  }

  /** Set status (no-op if unchanged) and append `agent.status`. */
  setStatus(agentId: string, status: AgentStatus, text?: string): Agent {
    const a = this.agents.require(agentId, "agent");
    if (a.status === status) return a;
    const updated = this.agents.upsert({ ...a, status });
    this.events.append({ type: "agent.status", agentId, buildingId: a.homeBuildingId ?? a.buildingId, text: text ?? `${a.name} is ${status}`, payload: { status, from: a.status } });
    return updated;
  }

  /**
   * Where `agentId` should stand to reach `placeId`: a free seat for meeting rooms (seats held by
   * other bodies, or by their walk's destination, are taken), the place's tile otherwise.
   */
  standingTile(placeId: string, agentId: string): Tile | undefined {
    const place = this.layout.place(placeId);
    if (!place || place.kind !== "meeting-room") return place?.pos;
    const taken = new Set<string>();
    let mine: Tile | undefined;
    for (const a of this.agents.where("status NOT IN ('banned','retired')")) {
      const t = this.movement.destination(a.id) ?? a.pos;
      if (a.id === agentId) mine = t;
      else taken.add(`${t.x},${t.y}`);
    }
    // already in (or headed for) a free seat at this table: keep it
    if (mine && !taken.has(`${mine.x},${mine.y}`) && this.layout.seatsOf(placeId).some((s) => s.x === mine!.x && s.y === mine!.y)) return mine;
    return this.layout.freeSeat(placeId, taken);
  }

  /** Advance walking bodies by `dtMs`. */
  tick(dtMs: number): void {
    this.movement.tick(dtMs);
  }

  /** Start the 10 Hz tick loop (server). */
  start(hz = 10): void {
    if (this.clock) return;
    let last = Date.now();
    this.clock = setInterval(() => { const now = Date.now(); this.tick(now - last); last = now; }, 1000 / hz);
    this.clock.unref?.();
  }
  stop(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  /**
   * A human avatar moved client-side. Validates walkability, updates position (and buildingId),
   * broadcasts `agents.pos`. Returns false if rejected.
   */
  moveHuman(agentId: string, x: number, y: number): boolean {
    const a = this.agents.get(agentId);
    if (!a || !this.layout.isWalkable(x, y)) return false;
    const buildingId = this.layout.buildingAt({ x, y })?.id ?? null;
    const moved = this.agents.upsert({ ...a, pos: { x, y }, buildingId, lastActiveAt: new Date().toISOString() }, { silent: buildingId === a.buildingId });
    this.changes.emit({ type: "agents.pos", positions: [{ id: moved.id, x, y, status: moved.status }] });
    return true;
  }

  /** Same shape as the WS `snapshot` message and `GET /api/town`. */
  snapshot(): SnapshotMessage {
    return {
      type: "snapshot",
      town: this.town.get(),
      buildings: this.buildingsWithIntray(),
      agents: this.agents.where("status NOT IN ('banned','retired')"),
      places: this.layout.places,
      grid: this.layout.grid,
      meetings: this.meetings.where("phase IN ('scheduled','collecting','discussing')", [], "ORDER BY scheduledAt"),
      health: { docker: this.host.docker ?? true, ...(this.host.slots ? { slots: this.host.slots() } : {}) },
    };
  }

  /** Buildings as the snapshot carries them: plus `intray` (pending report count) and `budget`. */
  buildingsWithIntray(): SnapshotMessage["buildings"] {
    const counts = intrayCounts(this);
    return this.buildings.all().map((b) => ({ ...b, intray: counts.get(b.id) ?? 0, budget: this.budget.of(b.id) }));
  }

  export(dir = townEnv("EXPORT") ?? "./export"): ExportResult {
    return exportWorld(this, dir);
  }
  importV0(dir: string, opts: ImportV0Options = {}): ImportV0Result {
    return importV0(this, dir, opts);
  }
  /** Re-import a directory written by `export` (round trip). */
  importExport(dir: string): { buildings: number; agents: number; docs: number; meetings: number } {
    return importExport(this, dir);
  }
  seedDefaults(opts: SeedOptions = {}): SeedResult {
    return seedDefaults(this, opts);
  }

  close(): void {
    this.stop();
    this.db.close();
  }
}
