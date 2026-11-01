import { ToolResults } from "./forkstatus.ts";
import { ROOT_GOAL_ID, mapFlagOf, townEnv, type Agent, type AgentStatus, type Building, type BuildingDefaults, type DesksConfig, type MapLayout, type RedeployLive, type RedeployResult, type ServerMessage, type Tile } from "@muster-town/schema";
import { Bank } from "./bank.ts";
import { Budget } from "./budget.ts";
import { Goals } from "./goals.ts";
import { freeTokens } from "./free-tokens.ts";
import { Reorgs } from "./goal-changes.ts";
import { Streams } from "./streams.ts";
import { Grants } from "./grants.ts";
import { laneHold } from "./lanes.ts";
import { intrayCount, intrayCounts, isTownHallItem } from "./domain.ts";
import { migrateRoles } from "./migrate-roles.ts";
import { openDb, type DB } from "./db.ts";
import { deskBillToday, type BillSession, type DeskBill } from "./desk-bill.ts";
import { EventLog } from "./events.ts";
import { exportInWorker, exportWorld, importExport, worldSource, writeExport, type ExportResult } from "./export.ts";
import { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
import { Ops, type Actor } from "./ops.ts";
import { holderOf, Permissions, type Holder } from "./permissions.ts";
import { Presence } from "./presence.ts";
import { Secrets } from "./secrets.ts";
import { Media } from "./media.ts";
import { Transcripts } from "./transcripts.ts";
import { Skills } from "./skills.ts";
import { seedDefaults, type SeedOptions, type SeedResult } from "./seed.ts";
import { createRepos, type Repos } from "./store.ts";
import { Emitter } from "./util.ts";
import { makeVerbs, type Verbs } from "./verbs/index.ts";
import { WorldMap } from "./world/map.ts";
import { followRelayout } from "./entities.ts";
import { forbidden } from "./errors.ts";

const MAP_LAYOUT_WORDS: Record<MapLayout, string> = { fountain: "a town round a square", tree: "a plain tree", radial: "spokes round the Town Hall" };
import { Movement } from "./world/movement.ts";

export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;

/**
 * A pull request's CI as last read from GitHub: `pending` while a check on its head commit is queued or running (or none
 * has registered yet), `passed`/`failed` once every check finished, `merged`/`closed` when the PR is no longer open.
 */
export interface PrChecks {
  state: "pending" | "passed" | "failed" | "merged" | "closed";
  /** the head commit the checks ran on */
  sha: string | null;
  /** checks finished / all checks on that commit */
  done: number;
  total: number;
  /** names of the failed checks (state failed) */
  failed?: string[];
  /** when this was read (ISO) */
  checkedAt: string;
}

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
  /**
   * The last GitHub read of a pull request's CI (runtime/pr-checks.ts polls the PRs that `{pr}` waits name, about once a
   * minute). Undefined = not read yet; without it, `pr` waits never hold (and expire after 24 h).
   */
  prChecks?(pr: number): PrChecks | undefined;
  /** The runtime's live redeploy state (`GET /api/admin/redeploy`). */
  redeployStatus?(): RedeployLive;
  /** The runtime's last docker probe: false while docker is down (code desks can't start). Unset = not probed. */
  docker?: boolean;
  /** Work-session slots: live or starting sessions out of `desks.maxRunning`. Unset without a runtime. */
  slots?(): { running: number; max: number };
  /**
   * Set by the server: from now on answer desk and MCP calls 503 `{ restarting: true }` (the desk resends them), and resolve
   * once the calls already running have finished, or after `ms`. The redeploy calls it just before the restart.
   */
  quiesce?(ms: number): Promise<void>;
  /** A hosted collective (docs/hosted-collectives.md): runs only on its own API key, never the host's credentials. */
  hosted?: boolean;
}

/** A hosted collective's work waits on this until an admin adds an Anthropic API key at its Bank (HUD: "No key yet"). */

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
  /** the town goal tree (docs/goals.md) */
  readonly goalTree: Goals;
  /** "Change this goal" (the reorg) and the Planner (docs/goals.md, build step 5) */
  readonly reorgs: Reorgs;
  /** goal tree step 7: funding streams, earmarks and the draw order */
  readonly streams: Streams;
  /** skills: SKILL.md docs, bundled files, pins, usage (docs/skills.md) */
  readonly skills: Skills;
  /** collective secrets: encrypted values and their grants (docs/secrets.md) */
  readonly secrets: Secrets;
  /** uploaded screenshots and videos cited in docs (docs/multimedia.md) */
  readonly media: Media;
  /** session transcripts (SDK JSONL) kept for the retention period (docs/transcripts.md) */
  readonly transcripts: Transcripts;
  /** live sessions' tool results (in memory) for `fork_status` */
  readonly toolResults = new ToolResults();
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
  readonly schedules: Repos["schedules"];
  readonly keyResults: Repos["keyResults"];
  readonly objectives: Repos["objectives"];
  readonly goals: Repos["goals"];
  /** exploration reservations (docs/how-work-gets-done.md §7): empty until the declarative explore step opens them */
  readonly bankReservations: Repos["bankReservations"];
  readonly goalProposals: Repos["goalProposals"];
  readonly goalChanges: Repos["goalChanges"];
  readonly kpis: Repos["kpis"];
  readonly accessRequests: Repos["accessRequests"];
  readonly captainRequests: Repos["captainRequests"];
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
    this.grants = repos.grants; this.schedules = repos.schedules; this.keyResults = repos.keyResults; this.objectives = repos.objectives; this.goals = repos.goals; this.bankReservations = repos.bankReservations; this.goalProposals = repos.goalProposals; this.goalChanges = repos.goalChanges; this.kpis = repos.kpis; this.accessRequests = repos.accessRequests; this.captainRequests = repos.captainRequests; this.skillPins = repos.skillPins;
    this.tokens = repos.tokens; this.town = repos.town;
    this.events = new EventLog(db, this.changes);
    this.permissions = new Permissions(repos, () => !!this.host.hosted);
    this.bank = new Bank(repos, this.events, this.permissions);
    this.budget = new Budget(repos, this.events, this.bank, this.changes);
    this.layout = new WorldMap(db, repos);
    this.layout.follow = (before, moved) => followRelayout(this, before, moved);
    this.movement = new Movement(repos, this.layout, this.events, this.changes);
    this.verbs = makeVerbs(this);
    this.ops = new Ops(this);
    this.grantDesk = new Grants(this);
    this.goalTree = new Goals(this);
    this.reorgs = new Reorgs(this);
    this.streams = new Streams(this);
    this.budget.gate = (a) => laneHold(this, a);
    this.budget.afterCharge = (bid) => this.grantDesk.checkpoints(bid);
    this.bank.freeTokens = () => freeTokens(this, ROOT_GOAL_ID);
    this.skills = new Skills(this);
    this.secrets = new Secrets(this);
    this.media = new Media(this);
    this.transcripts = new Transcripts(this);
    this.presence = new Presence(this);
    // agent.activity is server-maintained from events
    this.events.addHook((e) => {
      if (!e.agentId || (e.type !== "agent.activity" && e.type !== "agent.tool")) return;
      const a = this.agents.get(e.agentId);
      if (a) this.agents.upsert({ ...a, activity: e.text, lastActiveAt: e.ts });
    });
    // in-tray badge: a report arrived or was decided, or a grant moved → resend the building with its count;
    // a manager's report and every grant change also resend the Town Hall, whose in-tray they land in; so does a key result
    // marked met or missed (or deleted), which takes a closed-as-done grant out of the Town Hall in-tray without a grant event;
    // and so does a goal proposal, made or decided
    this.events.addHook((e) => {
      const p = e.payload as Record<string, unknown>;
      const report = (e.type === "doc.created" && p.docType === "report") || e.type === "doc.decision";
      // a goal proposal made or decided (step 4: it is a Town Hall item, and a human's may name no building)
      const grant = e.type.startsWith("grant.") || e.type === "kr.updated" || e.type === "kr.deleted" || e.type === "goal.proposal";
      if (!(report || grant) || (!e.buildingId && e.type !== "goal.proposal")) return;
      const b = e.buildingId ? this.buildings.get(e.buildingId) : undefined;
      if (b) this.changes.emit({ type: "building", building: { ...b, intray: intrayCount(this, b.id) } });
      const doc = report && typeof p.docId === "string" ? this.docs.get(p.docId) : undefined;
      const th = grant || (doc && isTownHallItem(this, doc)) ? this.buildings.first("kind = 'town-hall'") : undefined;
      if (th && th.id !== b?.id) this.changes.emit({ type: "building", building: { ...th, intray: intrayCount(this, th.id) } });
    });
    // outbox badge: a request was filed, claimed, finished or deleted → resend the unclaimed count
    this.events.addHook((e) => {
      const p = e.payload as Record<string, unknown>;
      const filed = e.type === "doc.created" && p.docType === "request";
      const moved = e.type === "doc.updated" && (typeof p.requestStatus === "string" || (p.deleted === true && typeof p.docId === "string"));
      if (filed || moved) this.changes.emit({ type: "outbox", open: this.outboxOpen() });
    });
    // goal-directed: a grant, key-result or budget-settings change may block or unblock the building (wakes its manager once)
    this.events.addHook((e) => {
      if (!e.buildingId || !(e.type.startsWith("grant.") || e.type.startsWith("kr.") || e.type === "building.updated")) return;
      this.grantDesk.syncBlocked(e.buildingId);
    });
    // the stoplight (map banner, board) follows grants, key results: resend the building with it
    this.events.addHook((e) => {
      if (!e.buildingId || !(e.type.startsWith("grant.") || e.type.startsWith("kr.") || e.type === "building.updated" || e.type === "building.blocked")) return;
      const b = this.buildings.get(e.buildingId);
      if (b) this.changes.emit({ type: "building", building: { ...b, stoplight: this.grantDesk.stoplight(b) } });
    });
    // the map is drawn from the goal tree: any tree change (add, edit, move or retire a goal, attach a building) redraws it
    this.events.addHook((e) => {
      if (e.type === "goal.created" || e.type === "goal.edited" || e.type === "goal.moved" || e.type === "goal.retired" || e.type === "goal.attached") this.layout.rebuild();
    });
    // "Change this goal": its planning meeting starting sets the new words; its end decides the change
    this.events.addHook((e) => {
      if (e.type !== "meeting.phase") return;
      const m = this.meetings.get(String((e.payload as { meetingId?: unknown }).meetingId ?? ""));
      if (m && m.kind === "planning" && !m.buildingId) this.reorgs.onMeetingPhase(m);
    });
    this.goalTree.ensure();
    this.layout.rebuild();
    this.repairDesks();
    this.grantDesk.releaseHalfway();
  }

  /** Boot repair: residents without a desk get one; a body left standing on someone else's desk moves to its own. */
  private repairDesks(): void {
    const fixed = this.layout.repairDesks();
    if (!fixed.length) return;
    const desks = new Set(this.layout.places.filter((p) => p.kind === "desk").map((p) => `${p.pos.x},${p.pos.y}`));
    for (const { agentId, place } of fixed) {
      const a = this.agents.require(agentId);
      const stacked = desks.has(`${a.pos.x},${a.pos.y}`) && (a.pos.x !== place.pos.x || a.pos.y !== place.pos.y);
      if (stacked) this.agents.upsert({ ...a, pos: { ...place.pos }, buildingId: place.buildingId }, { silent: true });
      this.events.append({ type: "system", agentId, buildingId: place.buildingId, text: `${a.name} got their own desk (${place.name})${stacked ? " and moved off the desk they shared" : ""}`, payload: { deskRepair: true, placeId: place.id } });
    }
  }

  /** collective.json `desks` as stored at seed (defaults: backend auto, image muster-town-desk, ghToken gh-cli). */
  desksConfig(): DesksConfig {
    return this.town.desks();
  }
  /** Change the live host settings (`PUT /api/town/desks`); the scheduler reads them on every pass. */
  setDesksConfig(patch: Partial<DesksConfig>): DesksConfig {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<DesksConfig>;
    const desks = this.town.setDesks({ ...this.town.desks(), ...given });
    const what = [given.maxRunning !== undefined ? `Session slots set to ${desks.maxRunning}` : null, given.billCapUsd !== undefined ? `Desk bill cap set to $${desks.billCapUsd}/day` : null].filter(Boolean).join("; ");
    this.events.append({ type: "system", text: what || "Desk settings saved", payload: { desks: true, maxRunning: desks.maxRunning, billCapUsd: desks.billCapUsd } });
    return desks;
  }

  /** Who may pick the map's shape: an admin (`goals.edit` town-wide) or a human who owns a goal of this town. */
  canSetMapLayout(actor: Actor): boolean {
    if (!actor || this.permissions.can(actor, "goals.edit")) return true;
    if (holderOf(actor).kind !== "user") return false;
    const id = holderOf(actor).id;
    return this.goals.exists("status = 'active' AND ownerId = ?", [id]);
  }
  /**
   * Pick the shape the map draws the goal tree in (`PUT /api/town/map-layout`, 1:1 mt_q10xf3bkoq): town-wide, for everyone.
   * Redraws the map at once (bodies follow, like a tree edit) and logs it.
   */
  setMapLayout(layout: MapLayout, actor: Actor): MapLayout {
    if (!this.canSetMapLayout(actor)) throw forbidden("goals.edit", "Only an admin or a goal captain can change the map's shape.");
    const was = this.town.get().mapLayout;
    if (was === layout) return layout;
    this.town.set({ mapLayout: layout });
    this.layout.rebuild();
    this.events.append({ type: "system", agentId: actor?.id ?? null, text: `The map is now drawn as ${MAP_LAYOUT_WORDS[layout]} (was ${MAP_LAYOUT_WORDS[was]})`, payload: { mapLayout: layout, from: was } });
    return layout;
  }

  /**
   * Set the operating reserve (`PUT /api/town/operating-reserve`, an admin; 1:1 mt_lb7tm75jgb): tokens of the general
   * balance free tokens leave out, so exploration and grant funding can't claim them. The caller checks admin. Logs it.
   */
  setOperatingReserve(tokens: number, by: string | null = null): number {
    const was = this.town.get().operatingReserveTokens;
    if (was === tokens) return tokens;
    this.town.set({ operatingReserveTokens: tokens });
    this.events.append({ type: "system", agentId: by, text: `Operating reserve set to ${tokens.toLocaleString("en-US")} tokens (was ${was.toLocaleString("en-US")})`, payload: { operatingReserveTokens: tokens, from: was } });
    return tokens;
  }

  /**
   * Save the collective defaults (`PUT /api/town/defaults`, 1:1 mt_n25udpflus decision 3) and write them through to every
   * lab, so the Building columns stay the effective values every reader uses. The Town Hall keeps its own (no code access).
   */
  setTownDefaults(patch: Partial<BuildingDefaults>, by: string | null = null): { defaults: BuildingDefaults; buildings: Building[] } {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<BuildingDefaults>;
    return this.transaction(() => {
      this.town.set({ defaults: { ...this.town.defaults(), ...given } });
      const defaults = this.town.defaults();
      const buildings = this.buildings.all().filter((b) => b.kind === "lab").map((b) => this.buildings.upsert({ ...b, ...defaults }));
      this.events.append({ type: "system", agentId: by, text: `Collective defaults saved (${Object.keys(given).join(", ")}) for ${buildings.length} building${buildings.length === 1 ? "" : "s"}`, payload: { townDefaults: true, fields: Object.keys(given), defaults } });
      for (const b of buildings) this.budget.resumeEligible(b.id); // a raised daily budget un-blocks residents that hit the old cap
      return { defaults, buildings };
    });
  }

  /**
   * Today's (UTC) town-wide desk bill against `desks.billCapUsd` (gr_uhh6u39vv9 step 3). Desks off Fly cost nothing here.
   * The runtime reads it at each desk session start; GET /api/health `desks` and the monitor's `desk-bill` show it.
   */
  deskBill(now = new Date()): DeskBill {
    const desks = this.desksConfig();
    const dayStart = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000).toISOString();
    const rows = desks.backend !== "fly" ? [] : this.db.prepare(`SELECT backend, startedAt, endedAt, wallMs, cpuKind, cpus, memoryMb FROM sessions
      WHERE backend != 'host' AND (endedAt IS NULL OR endedAt >= ?)`).all(dayStart) as BillSession[];
    return deskBillToday(rows, desks.billCapUsd, now);
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
    return this.agents.get(id)?.name ?? this.users.get(id)?.name ?? (id === "system" ? "Town" : id);
  }

  /** Set status (no-op if unchanged) and append `agent.status`. */
  setStatus(agentId: string, status: AgentStatus, text?: string, extra: Record<string, unknown> = {}): Agent {
    const a = this.agents.require(agentId, "agent");
    if (a.status === status) return a;
    const updated = this.agents.upsert({ ...a, status });
    this.events.append({ type: "agent.status", agentId, buildingId: a.homeBuildingId ?? a.buildingId, text: text ?? `${a.name} is ${status}`, payload: { ...extra, status, from: a.status } });
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
      flags: this.docs.where("type = 'flag' AND decision = 'pending' AND pickedUpAt IS NULL AND flagPos IS NOT NULL", [], "ORDER BY createdAt").map(mapFlagOf).filter((f) => f !== null),
      grid: this.layout.grid,
      meetings: this.meetings.where("phase IN ('scheduled','collecting','discussing')", [], "ORDER BY scheduledAt"),
      health: { docker: this.host.docker ?? true, ...(this.host.slots ? { slots: this.host.slots() } : {}),
        ...(this.host.hosted ? { funding: this.bank.liveApiKeyInput() ? "api-key" as const : "none" as const } : {}) },
      outbox: this.outboxOpen(),
    };
  }

  /** Outbox requests nobody has claimed yet (requestStatus open): the map's outbox badge. */
  outboxOpen(): number {
    return this.docs.count("type = 'request' AND requestStatus = 'open'");
  }

  /** Buildings as the snapshot carries them: plus `intray` (pending report count), `budget` and `stoplight`. */
  buildingsWithIntray(): SnapshotMessage["buildings"] {
    const counts = intrayCounts(this);
    return this.buildings.all().map((b) => ({ ...b, intray: counts.get(b.id) ?? 0, budget: this.budget.of(b.id), stoplight: this.grantDesk.stoplight(b) }));
  }

  export(dir = townEnv("EXPORT") ?? "./export"): ExportResult {
    return exportWorld(this, dir);
  }
  /**
   * The hourly export off the event loop: a worker on its own read-only connection to this town's db file (an in-memory
   * db has no file to share, so it runs here). Appends nothing: the runtime appends the one `export.done`.
   */
  async exportOffThread(dir = townEnv("EXPORT") ?? "./export"): Promise<ExportResult> {
    return this.db.memory ? writeExport(worldSource(this), dir) : exportInWorker(this.db.name, dir);
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
