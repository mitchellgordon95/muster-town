import type { Agent, AgentStatus, DesksConfig, ServerMessage } from "@agent-town/schema";
import { Budget } from "./budget.ts";
import { openDb, type DB } from "./db.ts";
import { EventLog } from "./events.ts";
import { exportWorld, importExport, type ExportResult } from "./export.ts";
import { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
import { Ops } from "./ops.ts";
import { holderOf, Permissions, type Holder } from "./permissions.ts";
import { seedDefaults, type SeedOptions, type SeedResult } from "./seed.ts";
import { createRepos, type Repos } from "./store.ts";
import { Emitter } from "./util.ts";
import { makeVerbs, type Verbs } from "./verbs/index.ts";
import { WorldMap } from "./world/map.ts";
import { Movement } from "./world/movement.ts";

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;

export class World {
  readonly db: DB;
  /** Every live change as a WS ServerMessage: event, agent, agents.pos, doc, meeting, building, assignment. */
  readonly changes = new Emitter<ServerMessage>();
  readonly events: EventLog;
  readonly permissions: Permissions;
  readonly budget: Budget;
  readonly layout: WorldMap;
  readonly movement: Movement;
  readonly verbs: Verbs;
  readonly ops: Ops;

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
  readonly tokens: Repos["tokens"];
  readonly town: Repos["town"];

  private clock: ReturnType<typeof setInterval> | null = null;

  /** Open (or create) the town database at `dbPath` (":memory:" works) and build the layout. */
  static open(dbPath: string): World {
    return new World(openDb(dbPath));
  }

  constructor(db: DB) {
    this.db = db;
    const repos = createRepos(db, this.changes);
    this.users = repos.users; this.roles = repos.roles; this.memberships = repos.memberships;
    this.buildings = repos.buildings; this.allocations = repos.allocations; this.agents = repos.agents;
    this.places = repos.places; this.docs = repos.docs; this.assignments = repos.assignments;
    this.messages = repos.messages; this.meetings = repos.meetings; this.sessions = repos.sessions;
    this.interrupts = repos.interrupts;
    this.tokens = repos.tokens; this.town = repos.town;
    this.events = new EventLog(db, this.changes);
    this.permissions = new Permissions(repos);
    this.budget = new Budget(repos, this.events);
    this.layout = new WorldMap(db, repos);
    this.movement = new Movement(repos, this.layout, this.events, this.changes);
    this.verbs = makeVerbs(this);
    this.ops = new Ops(this);
    // agent.activity is server-maintained from events
    this.events.addHook((e) => {
      if (!e.agentId || (e.type !== "agent.activity" && e.type !== "agent.tool")) return;
      const a = this.agents.get(e.agentId);
      if (a) this.agents.upsert({ ...a, activity: e.text, lastActiveAt: e.ts });
    });
    this.layout.rebuild();
  }

  /** collective.json `desks` as stored at seed (defaults: backend auto, image agent-town-desk, ghToken gh-cli). */
  desksConfig(): DesksConfig {
    return this.town.desks();
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
      buildings: this.buildings.all(),
      agents: this.agents.where("status != 'banned'"),
      places: this.layout.places,
      grid: this.layout.grid,
      meetings: this.meetings.where("phase IN ('scheduled','collecting','discussing')", [], "ORDER BY scheduledAt"),
    };
  }

  export(dir = process.env.AGENT_TOWN_EXPORT ?? "./export"): ExportResult {
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
