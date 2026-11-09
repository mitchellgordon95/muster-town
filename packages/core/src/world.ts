import { ToolResults } from "./forkstatus.ts";
import { NOT_GONE, ROOT_GOAL_ID, canTransition, mapFlagOf, townEnv, type Agent, type AgentStatus, type Building, type BuildingDefaults, type DesksConfig, type FounderProgress, type MapLayout, type RedeployLive, type RedeployResult, type RepoMode, type ServerMessage, type Tile, type TownPublish, type Town, type PublishTokenSource } from "@muster-town/schema";
import { Bank } from "./bank.ts";
import { Budget } from "./budget.ts";
import { Goals } from "./goals.ts";
import { freeTokens } from "./free-tokens.ts";
import { Reorgs } from "./goal-changes.ts";
import { Secretary } from "./secretary.ts";
import { backfillAsks } from "./asks.ts";
import { Streams } from "./streams.ts";
import { Grants } from "./grants.ts";
import { laneHold } from "./lanes.ts";
import { intrayCount, intrayCounts, isTownHallItem, moveManagerRowsToBuildingQueue } from "./domain.ts";
import { migrateRoles } from "./migrate-roles.ts";
import { openDb, type DB } from "./db.ts";
import { AppError } from "./errors.ts";
import { deskBillToday, type BillSession, type DeskBill } from "./desk-bill.ts";
import { EventLog } from "./events.ts";
import { exportDoneEvent, exportInWorker, exportWorld, importExport, worldSource, writeExport, type ExportResult, type PublishTarget } from "./export.ts";
import { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
import { Ops, type Actor } from "./ops.ts";
import { holderOf, Permissions, type Holder } from "./permissions.ts";
import { Presence } from "./presence.ts";
import { PUBLISH_TOKEN_SECRET, REPO_TOKEN_SECRET, Secrets } from "./secrets.ts";
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

/** "git@github.com:O/agent-town.git", "https://github.com/o/agent-town" → "github.com/o/agent-town": one repo, however it is cloned. */
export function repoKey(url: string): string {
  const u = url.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
  return u.replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, "").replace(/:\d+\//, "/");
}

/**
 * Main's CI (gr_7op2v8fjcl): `green` once every check on main's head finished and passed, `red` once one failed
 * (`failedStep` names the failed check runs), `pending` while they run. `since` is the first read that saw this state
 * (kept in meta `mainCi`, so it survives a restart); `fixer` is the agent holding the fix assignment (the building's manager while it is queued; core/main-fix.ts).
 */
export interface MainCi {
  state: "green" | "red" | "pending";
  sha: string;
  failedStep: string | null;
  since: string;
  fixer: string | null;
  /** the last red sha a fix assignment covers (core/main-fix.ts `queueMainFix`): one fix assignment per red sha */
  fixSha?: string | null;
  /** the red episode's fix assignment: while it is open, a new red sha gets no second one */
  fixAssignmentId?: string | null;
  /** when this was read (ISO) */
  checkedAt: string;
}

/** Host-side hooks the runtime fills in; core verbs call them when present. */
export interface HostHooks {
  /** Pull main, reinstall, rebuild, restart (runtime/redeploy.ts). A request while one runs joins it: `{ queued: true }`. */
  redeploy?(o: { image: boolean; restart?: string; requestedBy: string }): Promise<RedeployResult> | RedeployResult;
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
  /** GET one of the town's own API paths in-process, as a signed-out reader (set by the server): an ask's `api` claim check (ask-checks.ts). */
  apiGet?(path: string): Promise<{ status: number; body: unknown }>;
  /** Run an ask's claim checks in the background as it is filed (set by the server; unset in tests and scripts, which run no network). */
  claimChecks?: boolean;
  /** Main's CI as last read from GitHub (runtime/pr-checks.ts, about once a minute): `GET /api/health` `main`. Unset without a runtime. */
  mainCi?(): MainCi | undefined;
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
  /** The repo the running server was built from (`git remote get-url origin` of its checkout), set by the runtime: `repoMode` compares the collective's repo with it. */
  repoUrl?: string;
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
  /** the Town Hall's Secretary: the daily in-tray digest and its 1:1 (gr_kdlogzzo5s, secretary.ts) */
  readonly secretary: Secretary;
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
  /** Bank inputs with their secret column (the Bank's API is `bank`; this is for the boot back-fill and tests) */
  readonly bankInputs: Repos["bankInputs"];
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
  /** asks (docs/legible-delegation.md §4; core asks.ts) */
  readonly asks: Repos["asks"];
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
    this.users = repos.users; this.bankInputs = repos.bankInputs; this.roles = repos.roles; this.memberships = repos.memberships;
    this.buildings = repos.buildings; this.allocations = repos.allocations; this.agents = repos.agents;
    this.places = repos.places; this.docs = repos.docs; this.assignments = repos.assignments;
    this.messages = repos.messages; this.meetings = repos.meetings; this.sessions = repos.sessions;
    this.interrupts = repos.interrupts;
    this.grants = repos.grants; this.schedules = repos.schedules; this.keyResults = repos.keyResults; this.objectives = repos.objectives; this.goals = repos.goals; this.bankReservations = repos.bankReservations; this.goalProposals = repos.goalProposals; this.goalChanges = repos.goalChanges; this.kpis = repos.kpis; this.accessRequests = repos.accessRequests; this.captainRequests = repos.captainRequests; this.asks = repos.asks; this.skillPins = repos.skillPins;
    this.tokens = repos.tokens; this.town = repos.town;
    this.events = new EventLog(db, this.changes);
    this.permissions = new Permissions(repos, () => !!this.host.hosted, () => this.repoMode());
    this.bank = new Bank(repos, this.events, this.permissions);
    this.budget = new Budget(repos, this.events, this.bank, this.changes);
    this.layout = new WorldMap(db, repos);
    this.layout.follow = (before, moved) => followRelayout(this, before, moved);
    this.layout.beforeGrow = (buildingId, headcount) => this.goalTree.requireDesksFit(buildingId, this.goalTree.attachmentOf(buildingId), headcount);
    this.movement = new Movement(repos, this.layout, this.events, this.changes);
    this.verbs = makeVerbs(this);
    this.ops = new Ops(this);
    this.grantDesk = new Grants(this);
    this.goalTree = new Goals(this);
    this.reorgs = new Reorgs(this);
    this.secretary = new Secretary(this);
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
    moveManagerRowsToBuildingQueue(this);
    // asks (docs/legible-delegation.md §4): what already waits for a human gets its ask; idempotent
    backfillAsks(this);
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

  /** Set the retainer lookahead (`PUT /api/town/retainer-lookahead`, an admin): hours of due runs a retainer claims. Logs it. */
  setRetainerLookahead(hours: number, by: string | null = null): number {
    const was = this.town.get().retainerLookaheadHours;
    if (was === hours) return hours;
    this.town.set({ retainerLookaheadHours: hours });
    this.events.append({ type: "system", agentId: by, text: `Retainer lookahead set to ${hours} hours (was ${was})`, payload: { retainerLookaheadHours: hours, from: was } });
    return hours;
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

  /**
   * Set status (no-op if unchanged) and append `agent.status`. Only the moves in STATUS_TRANSITIONS (schema) are allowed:
   * any other throws a 409 conflict ("X is retired"), so nothing revives a gone agent (docs/invariants/agent-lifecycle.md).
   */
  setStatus(agentId: string, status: AgentStatus, text?: string, extra: Record<string, unknown> = {}): Agent {
    const a = this.agents.require(agentId, "agent");
    if (a.status === status) return a;
    if (!canTransition(a.status, status)) throw new AppError("conflict", `${a.name} is ${a.status}: can't become ${status}.`);
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
    for (const a of this.agents.where(NOT_GONE)) {
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
  /**
   * What code this collective works on (schema `RepoMode`; Mitchell, 1:1 mt_1vs893enaw: "collectives that aren't developing
   * Muster Town must not get the redeploy/PR machinery"). `none`: no `Town.workspace`. `own`: a repo that is not the one this
   * server runs from. `muster`: this server's own repo, or a repo with no known URL on either side (as before this mode).
   */
  repoMode(): RepoMode {
    const ws = this.town.get().workspace;
    if (!ws) return "none";
    if (!ws.repoUrl || !this.host.repoUrl) return "muster";
    return repoKey(ws.repoUrl) === repoKey(this.host.repoUrl) ? "muster" : "own";
  }

  /**
   * Who the collective's prompts and rollup heading address ("## Needs from <name>"; 1:1 mt_1vs893enaw decision 5): on
   * muster.town "Mitchell", unchanged; a collective on another repo or none, the root goal's captain (its founder, else
   * the first admin), or "your captain" while it has none.
   */
  captainName(): string {
    if (this.repoMode() === "muster") return "Mitchell";
    const root = this.goalTree.get(ROOT_GOAL_ID);
    const id = root?.ownerId ?? this.goalTree.firstAdminId();
    return (id ? this.users.get(id)?.name?.trim() : "") || "your captain";
  }

  snapshot(): SnapshotMessage {
    return {
      type: "snapshot",
      town: this.townView(),
      buildings: this.buildingsWithIntray(),
      agents: this.agents.where(NOT_GONE),
      places: this.layout.places,
      flags: this.docs.where("type = 'flag' AND decision = 'pending' AND pickedUpAt IS NULL AND flagPos IS NOT NULL", [], "ORDER BY createdAt").map(mapFlagOf).filter((f) => f !== null),
      grid: this.layout.grid,
      meetings: this.meetings.where("phase IN ('scheduled','collecting','discussing')", [], "ORDER BY scheduledAt"),
      health: { docker: this.host.docker ?? true, repoMode: this.repoMode(), ...(this.host.slots ? { slots: this.host.slots() } : {}),
        ...(this.host.hosted ? { funding: this.bank.liveApiKeyInput() ? "api-key" as const : "none" as const, founder: this.founderProgress(), started: this.hasRun() } : {}) },
      outbox: this.outboxOpen(),
    };
  }

  /**
   * Whether an agent ever worked here: any work, manage or review session (not naming or summaries; the founder road's
   * `firstSessionAt`). False is a collective that has never run (a hosted one waiting for its founder's key).
   */
  hasRun(): boolean {
    return this.sessions.count("purpose IN ('work', 'manage', 'review')") > 0;
  }

  /** A hosted collective's founder road (TownHealth `founder`): latest exploration start, open proposals, ever funded. */
  founderProgress(): FounderProgress {
    const ex = this.db.prepare("SELECT ts FROM events WHERE type = 'exploration.started' ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined;
    return { exploringSince: ex?.ts ?? null, proposals: this.grants.count("status IN ('proposed', 'countered')"), funded: this.grants.count("fundedAt IS NOT NULL") > 0 };
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
    const publish = this.publishTarget();
    return this.db.memory ? writeExport(worldSource(this), dir, publish) : exportInWorker(this.db.name, dir, publish);
  }

  /**
   * Publish to GitHub (gr_30f8obzab8): where this World's export pushes, read from this World's own town meta and secret
   * (a hosted collective's runtime reads its own, so its export dir only ever pushes to its own repo). null when unset.
   */
  publishTarget(): PublishTarget | null {
    const p = this.town.get().publish;
    if (!p?.repoUrl) return null;
    // its own token first; else the collective's GH_TOKEN (1:1 mt_z1b38bwg98: one all-repos token can serve both)
    const token = this.secrets.value(PUBLISH_TOKEN_SECRET) ?? this.secrets.value(REPO_TOKEN_SECRET);
    return { repoUrl: p.repoUrl, token, lastPushCommit: p.lastPushCommit };
  }

  /** Which token the next push uses: Publish's own, the collective's GH_TOKEN secret (the fallback), or none. Read live, never stored. */
  publishTokenSource(): PublishTokenSource {
    if (this.secrets.hasOwn(PUBLISH_TOKEN_SECRET)) return "own";
    return this.secrets.hasOwn(REPO_TOKEN_SECRET) ? "collective" : "none";
  }

  /** The town as GET /api/town and the snapshot show it: `publish.tokenSource` filled in live. */
  townView(): Town {
    const t = this.town.get();
    return t.publish ? { ...t, publish: { ...t.publish, tokenSource: this.publishTokenSource() } } : t;
  }

  /** One finished export: append its `export.done` and write the push outcome into `Town.publish` (when a repo is set and a push was due). */
  recordExport(r: ExportResult): void {
    this.events.append(exportDoneEvent(r));
    const p = this.town.get().publish;
    if (!p || (!r.pushedAt && !r.pushError)) return;
    this.town.set({ publish: r.pushedAt ? { ...p, lastPushAt: r.pushedAt, lastPushCommit: r.pushCommit, lastPushError: null } : { ...p, lastPushError: r.pushError } });
  }

  /**
   * PUT /api/town/publish (an admin): the repo the hourly export pushes to and, when given, its token (stored as the
   * runtime-owned secret; 409 without a data key). No token keeps the stored one. A new repo URL resets the last-push
   * fields so the next export pushes. The event never carries the token.
   */
  setPublish(input: { repoUrl: string; token?: string }, by: string | null = null): TownPublish {
    const repoUrl = input.repoUrl.trim();
    if (input.token !== undefined) this.secrets.setOwn(PUBLISH_TOKEN_SECRET, input.token, by);
    const cur = this.town.get().publish;
    const same = cur?.repoUrl === repoUrl && input.token === undefined;
    const publish: TownPublish = {
      repoUrl, tokenSet: this.secrets.hasOwn(PUBLISH_TOKEN_SECRET),
      lastPushAt: same ? cur.lastPushAt : null, lastPushCommit: same ? cur.lastPushCommit : null, lastPushError: same ? cur.lastPushError : null,
    };
    this.town.set({ publish });
    publish.tokenSource = this.publishTokenSource();
    this.events.append({ type: "town.publish-set", agentId: by, text: `Publish to GitHub set to ${repoUrl}${input.token !== undefined ? " (token saved)" : ""}`, payload: { repoUrl, tokenSaved: input.token !== undefined, tokenSet: publish.tokenSet, tokenSource: publish.tokenSource } });
    return publish;
  }

  /** DELETE /api/town/publish (an admin): forget the repo, its token and the last-push fields. */
  clearPublish(by: string | null = null): { cleared: boolean } {
    const had = !!this.town.get().publish;
    const token = this.secrets.clearOwn(PUBLISH_TOKEN_SECRET);
    if (!had && !token) return { cleared: false };
    this.town.set({ publish: undefined });
    this.events.append({ type: "town.publish-cleared", agentId: by, text: "Publish to GitHub cleared", payload: { tokenRemoved: token } });
    return { cleared: true };
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
