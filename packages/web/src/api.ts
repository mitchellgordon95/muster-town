/**
 * Typed client for the Muster Town server (REST + WS). The same `Api` interface is
 * implemented by `mock/server.ts` so the whole UI runs without a backend (VITE_MOCK=1).
 */
import type { z } from "zod";
import type {
  ReviewDeck,
  CreateObjectiveInput, UpdateObjectiveInput, Objective, KpiKey, KpiView,
  AccessRequest, AccessRequestView, Agent, Allocation, Assignment, AuthMe, BlockedAssignment, BuildingStats, Schedule, RedeployLive, Building, ClientMessage, DesksConfig, Doc, Event, Lot, Meeting, Place, Role, Membership, SessionSlots, Tile,
  ServerMessage, SessionView, TokenCounts, Town, CreateBuildingInput, UpdateBuildingInput, RegisterVisitorInput,
  ReviewInput, PinSkillInput, SkillPinView, SkillView, PutSecretInput, SecretView, ChatInput, WorkInput, DonateInput, AddBankInput, BankInput, CreateBankPoolInput, UpdateBankPoolInput, CreateMeetingInput, DocState, DocType, Mailbox, Permission, DecideGrantInput, CloseGrantInput, GrantView, KeyResult, CreateKeyResultInput, UpdateKeyResultInput, Stoplight,
  GoalTreeNode, Goal, GoalProposal, GoalSpend, IntrayRoutes, CreateGoalInput, UpdateGoalInput, RetireGoalInput, CreateTreeKeyResultInput, DecideGoalProposalInput,
} from "@muster-town/schema";

export type In<T extends z.ZodTypeAny> = z.input<T>;
export type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;
export type Grid = Snapshot["grid"];

export interface AgentDetail {
  agent: Agent;
  recentEvents: Event[];
  currentSession: SessionView | null;
  latestReport: Doc | null;
  /** titles of the agent's wiki pages: what it knows (public) */
  memoryTopics?: string[];
  /** the agent's memory (wiki pages, newest first, and its log): only for its owner, its building's managers and admins */
  memory?: { wiki: Doc[]; log: Doc | null };
  assignments: Assignment[];
  /** v1.4, visitors only: unread inbox messages, unread mentions, open offers */
  mailbox?: Mailbox;
  /** v1.5: what the agent can do (town-level, plus building-scoped for its home building) */
  effectivePermissions?: Permission[];
  permissions?: AgentPermissionsView;
  /** manager forks (step 5): a fork's assignment, session, report and edited topic pages */
  fork?: ForkSummary;
}
/** A manager and all its forks' spend (GET /api/agents/:id/forks `family`), as core's familySpend: adjusted tokens the Bank booked. */
export interface FamilySpend { today: number; /** the forks' part of today */ forksToday: number; /** the family's daily cap (dailyTokensPerAgent × headcount) */ cap: number; total: number; usdTotal: number; forks: number }

/** One manager fork (GET /api/agents/:id `fork`, GET /api/agents/:id/forks), as core's forkSummary. */
export interface ForkSummary {
  agent: Agent;
  forkOfName: string;
  assignmentId: string | null;
  assignmentTitle: string | null;
  chainId: string | null;
  hop: number | null;
  sessionId: string | null;
  /** the session's adjusted output tokens */
  tokens: number;
  /** the session's wall, CPU and steal ms (null = running or not measured) */
  wallMs?: number | null;
  cpuMs?: number | null;
  stealMs?: number | null;
  /** the desk Machine size it ran on (null = host, docker or before the size was recorded) */
  cpuKind?: "shared" | "performance" | null;
  cpus?: number | null;
  memoryMb?: number | null;
  /** a kept transcript exists for the session */
  transcript: boolean;
  reportId: string | null;
  reportTitle: string | null;
  pagesEdited: { id: string; title: string }[];
}
/** A fork-authored report's place on its assignment chain (the in-tray's chain badge). */
export interface ReportChain { chainId: string; hop: number; prevReportId: string | null; sessionId: string | null; assignmentId: string; forkOf: string | null }
/** v1.5: how an agent's permissions resolve (GET /api/agents/:id, PATCH /api/agents/:id/permissions). */
export interface AgentPermissionsView {
  inheritsOwner: boolean;
  deniedPermissions: Permission[];
  ownerUserId: string | null;
  ownerName: string | null;
  /** the caller is the owner or an admin */
  canEdit: boolean;
  /** the owner's effective permissions; only sent when `canEdit` */
  ownerPermissions?: Permission[];
  /** the caller is the owner, an admin or a manager of its home building: may pick its model */
  canSetModel?: boolean;
}
/** POST /api/agents/:id/message result: how the message reached the agent. */
export interface StartNextResult { assignment: Assignment; agent: Agent; when: "now" | "after-current" }
export interface MessageResult { mode: "interrupted" | "queued" | "started"; messageId: string; assignmentId?: string }
/** One `tell` between an agent and your avatar (GET /api/agents/:id/thread). */
export interface ThreadMessage { id: string; fromId: string; toId: string; from: string; mine: boolean; body: string; at: string }
/** `POST /api/media`: the stored file and the markdown to cite it with. */
export interface UploadedMedia { media: { id: string; url: string; mime: string; bytes: number }; markdown: string }
export interface DocQuery { state?: DocState; type?: DocType; buildingId?: string; q?: string; limit?: number }
export interface CabinetQuery { type?: DocType; authorId?: string; limit?: number }
/** `GET /api/buildings/:id/cabinet`: the matching docs (newest first) and unfiltered counts per (type, author). */
export interface Cabinet { docs: Doc[]; counts: { type: DocType; authorId: string; n: number }[] }
export interface EventQuery { since?: number; agentId?: string; buildingId?: string; limit?: number }
/** `GET /api/budget` — the contract only says "per-building allocated/spent and per-user donated". */
export interface Budget {
  buildings: { buildingId: string; allocated: number; spent: number; spentUsd?: number; tokensToday?: number; tokensAllTime?: number }[];
  users: { userId: string; name?: string; donated: number }[];
}
/** Unspent allocation tokens by funding mode (retired allocations left out). */
export interface HeldByAuth { subscription: number; apiKey: number; donorKey: number }
/** `GET /api/allocations?buildingId=`: a building's allocations (retired ones too), newest first. */
export type AllocationRow = Allocation & { remainingTokens: number; userName: string };
/**
 * `GET /api/finance` (public) — core's FinanceSummary: what the town received, used, let expire and has left, in adj. tokens.
 * Identity: used + expired + left = total + overdrawn (overdrawn = usage past what was received, the overshoot debt).
 */
export interface Finance {
  total: number; credited: number; donated: number;
  used: number; usedBank: number; usedDonations: number;
  expired: number;
  left: number; leftBank: number; leftDonations: number;
  overdrawn: number;
  /** `overdrawn` by where it sits; the parts sum to `overdrawn` */
  overdrawnBreakdown: { durableOvershoot: number; subscriptionOverdrawn: number; deletedCreditDebits: number; allocationOverspent: number };
  /** the usage ledger's all-time total; can exceed `used` by usage nothing funds */
  usageLedger: number;
  projection: { days: number; trailingDailyBurn: number; burnDays: number; projectedUse30d: number };
  sumCheck: { ok: boolean; diff: number; identity: string };
  at: string;
}
/** One row of `GET /api/finance/spend`: a building, grant or assignment, or a synthetic row (no grant, no assignment, unattributed, weight mismatch, not funded). */
export interface SpendNode {
  kind: "building" | "grant" | "no-grant" | "assignment" | "no-assignment" | "unattributed" | "weight-mismatch" | "not-funded";
  /** null for the synthetic rows */
  id: string | null;
  name: string;
  tokens: number;
  /** tokens / used; negative for the weight-mismatch and not-funded rows */
  share: number;
  sessions: number;
  children?: SpendNode[];
}
/** `GET /api/finance/spend` (public) — core's FinanceSpend: `used` by building → grant → assignment; the top-level rows sum to `used`. */
export interface FinanceSpend {
  used: number; sessionsTotal: number; unattributed: number;
  /** pre-conversion sessions priced at their own model here vs at Opus weights in the Bank's ledger: pricing, not spend */
  weightMismatch: number; weightMismatchNote: string; convertedAt: string | null;
  notFunded: number;
  rows: SpendNode[];
  check: { ok: boolean; diff: number; identity: string };
  at: string;
}
/** One dated credit of a Bank input in `GET /api/finance/sources`; `expiredTokens` is what expired undrawn (subscription credits only). */
export interface SourceCredit { id: string; createdAt: string; expiresAt: string | null; tokens: number; expiredTokens: number }
/**
 * `GET /api/finance/sources` (public) — core's FinanceSources: where the tokens came from. One row per Bank input (with its
 * dated credits; a synthetic `id: null` row holds credits of deleted inputs) and one per direct donation (a retired one
 * counts min(size, spent) as `tokens`). creditedTokens + donatedTokens = totalReceived, which equals /api/finance `total`.
 */
export interface FinanceSources {
  inputs: {
    id: string | null; label: string; source: "api-key" | "subscription" | null; recurrence: "once" | "daily" | "weekly" | "monthly" | null;
    who: string; createdAt: string | null; cancelledAt: string | null;
    tokens: number; firstAt: string | null; lastAt: string | null; expiredTokens: number; credits: SourceCredit[];
  }[];
  donations: {
    id: string; label: string; who: string; buildingId: string; buildingName: string; createdAt: string;
    auth: "subscription" | "api-key" | "donor-key"; retired: boolean; sizeTokens: number; spentTokens: number; tokens: number;
  }[];
  creditedTokens: number; donatedTokens: number; totalReceived: number; expiredTokens: number;
  sumCheck: { ok: boolean; diff: number; identity: string };
  financeTotal: number; matchesFinance: boolean;
  at: string;
}
/**
 * `GET /api/finance/pools` (public) — core's FinancePools: how the Bank's tokens are divided into pools (each pool's % of
 * every credit, what it has left and any overdrawn debt) and what each building drew, was donated and holds. A synthetic
 * `id: null` row holds debits of deleted pools / buildings. Two checks: Σ building draws = Σ pool draws = Bank debits, and
 * Σ pools left − Σ pools overdrawn + unshared = Bank balance − overshoot.
 */
export interface FinancePools {
  pools: {
    id: string | null; name: string; pct: number; explicit: boolean; isDefault: boolean; buildings: { id: string; name: string }[];
    expiringLeft: number; durableLeft: number; left: number; overdrawn: number; drawn: number; dailyInflowTokens: number;
  }[];
  buildings: {
    id: string | null; name: string; poolId: string | null; poolName: string; drawsFromBank: boolean;
    drawn: number; drawnSubscription: number; drawnDurable: number; drawnMemberFunded: number;
    donated: number; donationsSpent: number; held: number; explorationTokensPerDay: number;
  }[];
  sharedPct: number; balanceTokens: number; overshootTokens: number;
  poolsLeftTokens: number; poolsOverdrawnTokens: number; unsharedTokens: number;
  usedBank: number; donatedTokens: number; heldTokens: number;
  sumCheck: { drawsOk: boolean; drawsDiff: number; balanceOk: boolean; balanceDiff: number; ok: boolean; identities: { draws: string; balance: string } };
  at: string;
}
/** One Fly Machine size's list price in `GET /api/finance/fly`. */
export interface FlyRate { preset: string; memoryMb: number; usdPerMonth: number; usdPerHour: number }
/** A building's desk time and cost in `GET /api/finance/fly` (over the window, or within one day). */
export interface FlyBuilding { id: string | null; name: string; deskMs: number; deskUsd: number; sessions: number }
/**
 * `GET /api/finance/fly` (public) — core's FinanceFly: what hosting on Fly.io costs, estimated from the town's own
 * records at Fly's list prices, per UTC day over the window (default 30 days, `?days=`): desk sessions' wall time ×
 * the desk Machine size's $/h, split by building, plus the town Machine's share of the day. Identities: per day
 * desk + town = total, and Σ days desk time = Σ buildings desk time. `notCounted` says what Fly bills that isn't here.
 */
export interface FinanceFly {
  windowDays: number; from: string; to: string;
  rates: { desk: FlyRate | null; town: FlyRate | null; extraRamUsdPerGbMonth: number; region: string; source: string; pricedAt: string };
  desksBackend: string; townOnFly: boolean; capUsdPerDay: number | null;
  today: { day: string; deskUsd: number; townUsd: number; totalUsd: number; capUsdPerDay: number | null; underCap: boolean | null };
  days: { day: string; deskMs: number; deskUsd: number; townUsd: number; totalUsd: number; sessions: number; buildings: FlyBuilding[] }[];
  buildings: FlyBuilding[];
  totals: { deskMs: number; deskHours: number; deskUsd: number; townUsd: number; totalUsd: number; sessions: number; unmeasuredSessions: number };
  notCounted: string[]; assumptions: string[];
  sumCheck: { ok: boolean; diff: number; identity: string; daysOk: boolean; buildingsOk: boolean };
  at: string;
}
/** `GET /api/bank` — core's BankSummary: the accounting pools, the inputs, each building's view (from its pool), and the top contributors. */
export interface BankPoolSummary {
  id: string; name: string;
  /** effective % of the Bank; `explicit` false = splits what's left equally with the other pools */
  pct: number; explicit: boolean;
  /** General, the default pool (can't be deleted) */
  isDefault: boolean;
  buildings: { buildingId: string; name: string }[];
  /** what the pool's buildings can still draw, first come first served */
  expiringTokens: number; durableTokens: number;
}
/** A building's view of the Bank: its pool's % and what's left in that pool (0 for the Town Hall). */
export interface BankBuildingShare { buildingId: string; name: string; poolId: string; poolName: string; pct: number; explicit: boolean; expiringTokens: number; durableTokens: number; heldTokens: number; heldByAuth?: HeldByAuth }
export interface BankContributor { userId: string; name: string; tokens: number; bankTokens: number; donatedTokens: number }
export interface Bank {
  balanceTokens: number;
  /** subscription tokens that expire at the next daily renewal */
  expiringTokens: number;
  /** API-key tokens, kept until spent */
  durableTokens: number;
  /** unspent tokens donated straight to buildings (outside the Bank's balance) */
  heldTokens: number;
  /** heldTokens by funding mode (older servers leave it out) */
  heldByAuth?: HeldByAuth;
  /** balanceTokens + heldTokens */
  townTokens: number;
  /** what the inputs credited, in adjusted output tokens (every Bank figure is, since step 3) */
  creditedTokens: number;
  /** the raw total of the credits' counters (older servers leave it out) */
  rawCreditedTokens?: number;
  /** what the inputs credited as the five counters */
  creditedCounts: TokenCounts;
  /** the credits' counters priced at list price (matches creditedTokens to rounding) */
  adjustedCreditedTokens: number;
  dailyInflowTokens: number;
  /** per input: `debitedTokens` (what grants it pays for drew by name) and `balanceTokens` (what it can still pay; member funding). Older servers leave them out. */
  inputs: (BankInput & { userName: string; creditedCounts: TokenCounts; adjustedCreditedTokens: number; debitedTokens?: number; balanceTokens?: number })[];
  pools: BankPoolSummary[];
  buildings: BankBuildingShare[];
  contributors: BankContributor[];
  /** Bank step 4: the latest drift run (null before the first; older servers leave it out) */
  drift?: BankDrift | null;
  /** Bank step 5: unexpected out-of-tokens deaths, last 7 days (older servers leave it out) */
  deaths?: BankDeaths;
  /** Bank step 5: the learned subscription cap and the hold near it (older servers leave it out) */
  cap?: BankCapState;
}
export interface BankDeaths {
  since: string; capDeaths: number; exhausted: number; total: number;
  events: { ts: string; kind: "cap" | "exhausted"; agentId: string | null; buildingId: string | null; sessionId: string | null; text: string }[];
}
export interface BankCapState {
  inputId: string | null; learnedCap: number | null; days: number; spentToday: number; windowStart: string;
  typicalSession: number | null; held: boolean; reason: string | null; resetsAt: string;
}
/** One drift row (core's DriftRow): ratio = adjusted output tokens × output list price / the SDK's costUsd */
export interface DriftRow {
  day: string; model: string | null; building: string | null; sessions: number; backfilled: number;
  adjustedOutputTokens: number; adjustedUsd: number; costUsd: number; ratio: number | null;
}
export interface BankDrift { day: string; ranAt: string; models: DriftRow[]; buildings: DriftRow[] }
/** A movable piece of furniture (anchors and offsets are lot-relative tiles). */
export interface LayoutPiece {
  key: string; label: string; at: Tile; current: Tile;
  cells: { dx: number; dy: number; tile: number }[]; stands: Tile[]; wall?: boolean; table?: boolean;
}
export interface RoomLayout { lot?: Lot; pieces: LayoutPiece[] }
export interface LayoutPreview { errors: { key: string | null; message: string }[]; furniture: Record<string, Tile>; grid: Grid; places: Place[] }

/** Town planning: the new building drawn on the map (name etc. as for createBuilding, plus its lot). */

/** GET /api/buildings/:id/intray: `grants` (proposed, countered, checkpoint) only for the Town Hall */
export interface Intray extends Partial<IntrayRoutes> { reports: Doc[]; chains?: Record<string, ReportChain>; grants: GrantView[]; goalProposals?: GoalProposalView[]; access?: AccessRequestView[]; blocked?: { buildingId: string; name: string; reason: string; since: string | null }[] }
/** A goal key result with the live (funded or checkpoint) grant working on it, if any, and who wrote / last edited it (core's GoalKeyResult). */
/** A goal proposal as GET /api/goal-proposals returns it (core GoalProposalView): flagged when outside the proposer's subtree. */
export type GoalProposalView = GoalProposal & { proposedByName: string; outsideScope: boolean };
export type GoalKeyResult = KeyResult & { grantId: string | null; createdByName?: string | null; editedByName?: string | null };
/** An objective of a building goal with the KPI it moves and its key results (core's ObjectiveView). */
export type ObjectiveView = Objective & { kpi: KpiKey | null; kpiName: string | null; keyResults: GoalKeyResult[]; createdByName?: string | null; editedByName?: string | null };
/** GET /api/buildings/:id/objectives: the objectives with their key results, then the key results under none. */
export interface ObjectiveTree { objectives: ObjectiveView[]; unsorted: GoalKeyResult[] }
/** GET /api/kpis: the framing, the town KPIs with live values, and every goal-directed building's objectives. */
export interface KpisView { framing: string; kpis: KpiView[]; buildings: (ObjectiveTree & { buildingId: string; name: string; goal: string })[] }
/** GET /api/buildings/:id/key-results */
export interface KeyResultsView { keyResults: GoalKeyResult[]; blocked: string | null }
/** GET /api/buildings/:id/board: the FYIs plus the budget part (core's GrantBoard; the Town Hall has no grants). */
export interface Board {
  /** the Town Hall's FYIs first (townWide: true, on every building's board but the Town Hall's own), then the building's */
  docs: (Doc & { townWide?: boolean })[];
  goal: string;
  /** the goal's key results, each with the live grant on it (null = open for exploration) */
  keyResults: GoalKeyResult[];
  /** the same key results grouped under the goal's objectives, then the ones under none */
  objectives: ObjectiveTree;
  /** "blocked: no key results to work toward", or null */
  blocked: string | null;
  /** green / yellow / red with the one-line reason; null for the Town Hall */
  stoplight: Stoplight | null;
  grants: GrantView[];
  /** open proposals (proposed or countered), newest first: several can be open at once */
  proposals: GrantView[];
  exploration: { allowanceTokens: number; spentTodayTokens: number };
}

export interface WriteDocInput { type?: DocType; title: string; body: string; state?: "draft" | "building"; tags?: string[]; /** FYIs only: the board to post to ("town-hall" = a town-wide FYI) */ buildingId?: string }
export type RequestAction = "claim" | "done" | "delete";

export interface Socket { send(msg: ClientMessage): void; close(): void }
export interface SocketHandlers { onMessage(msg: unknown): void; onOpen(): void; onClose(): void }

export interface Api {
  readonly mock: boolean;
  devAdminToken(): Promise<string | null>;
  me(): Promise<AuthMe>;
  /** a signed-in visitor asks to join (dc_f0cumcfubk); an admin decides from the Town Hall in-tray */
  requestAccess(message: string): Promise<AccessRequest>;
  decideAccess(id: string, grant: boolean): Promise<AccessRequest>;
  town(): Promise<Snapshot>;
  events(q: EventQuery): Promise<Event[]>;
  // buildings
  board(buildingId: string, limit?: number): Promise<Board>;
  cabinet(buildingId: string, q?: CabinetQuery): Promise<Cabinet>;
  createBuilding(input: In<typeof CreateBuildingInput>): Promise<Building>;
  /** GET /api/buildings/:id: the building row as stored (live budget settings such as `forks`) */
  building(id: string): Promise<Building>;
  updateBuilding(id: string, input: In<typeof UpdateBuildingInput>): Promise<Building>;
  /** GET /api/goals: the town goal tree from the root (docs/goals.md) */
  goalTree(): Promise<GoalTreeNode>;
  /** The goal editor (docs/goals.md "The Town Hall goal editor"): GET /api/goals?retired=1, a goal's history, and the edits (`goals.edit`). */
  goalTreeWithRetired(): Promise<GoalTreeNode>;
  goalHistory(id: string): Promise<Event[]>;
  goalSpend(id: string, days?: number): Promise<GoalSpend>;
  createGoal(input: In<typeof CreateGoalInput>): Promise<Goal>;
  updateGoal(id: string, input: In<typeof UpdateGoalInput>): Promise<Goal>;
  retireGoal(id: string, input: In<typeof RetireGoalInput>): Promise<Goal>;
  addTreeKeyResult(goalId: string, input: In<typeof CreateTreeKeyResultInput>): Promise<KeyResult>;
  goalProposals(status?: GoalProposal["status"]): Promise<GoalProposalView[]>;
  decideGoalProposal(id: string, input: In<typeof DecideGoalProposalInput>): Promise<GoalProposalView>;
  /** Furniture of a room, and the human-only editor's dry run / save (lot-relative anchors). */
  layout(buildingId: string): Promise<RoomLayout>;
  previewLayout(buildingId: string, furniture: Record<string, Tile>): Promise<LayoutPreview>;
  saveLayout(buildingId: string, furniture: Record<string, Tile>): Promise<Building>;
  /** Town planning (humans with town.manage_buildings): dry run / save new lots, optionally plus one new building. */
  // agents
  /** pending reports for the building's in-tray, oldest first; the Town Hall's also has the grants awaiting a human */
  intray(buildingId: string): Promise<Intray>;
  /** GET /api/review-deck: the Town Hall in-tray as slides, computed by the server (design dc_y7a8g257of §2) */
  reviewDeck(meetingId?: string): Promise<ReviewDeck & Partial<IntrayRoutes>>;
  /** GET /api/grants/:id: one grant or proposal (drafts only for its building's managers and funders) */
  grant(id: string): Promise<GrantView>;
  /** GET /api/buildings/:id/grants: every grant and proposal of the building (drafts only for its managers and funders) */
  grants(buildingId: string): Promise<GrantView[]>;
  /** POST /api/grants/:id/decide (building.fund): fund / counter / reject a proposal, continue / adjust / cut a checkpoint */
  decideGrant(id: string, input: In<typeof DecideGrantInput>): Promise<GrantView>;
  /** POST /api/grants/:id/close (`building.fund` any outcome; outcome "done" closes it early with the unspent rest back in the Bank) */
  closeGrant(id: string, input: In<typeof CloseGrantInput>): Promise<GrantView>;
  /** GET /api/buildings/:id/key-results: the goal's key results (with the live grant on each) and the blocked reason */
  keyResults(buildingId: string): Promise<KeyResultsView>;
  /** POST /api/buildings/:id/key-results (a human with building.manage writes the goal's key results) */
  createKeyResult(buildingId: string, input: In<typeof CreateKeyResultInput>): Promise<KeyResult>;
  /** PATCH /api/key-results/:id: text / howToCheck (human, building.manage); status (manager up to claimed, building.fund for met / missed) */
  updateKeyResult(id: string, input: In<typeof UpdateKeyResultInput>): Promise<KeyResult>;
  /** DELETE /api/key-results/:id (409 while a draft, open or live grant names it) */
  deleteKeyResult(id: string): Promise<void>;
  /** GET /api/buildings/:id/objectives */
  objectives(buildingId: string): Promise<ObjectiveTree>;
  /** POST /api/buildings/:id/objectives (a human with building.manage; at most 3) */
  createObjective(buildingId: string, input: In<typeof CreateObjectiveInput>): Promise<Objective>;
  /** PATCH /api/objectives/:id */
  updateObjective(id: string, input: In<typeof UpdateObjectiveInput>): Promise<Objective>;
  /** DELETE /api/objectives/:id (409 while key results hang off it) */
  deleteObjective(id: string): Promise<void>;
  /** GET /api/kpis: the town dashboard */
  kpis(): Promise<KpisView>;
  /** a signed-in person registers their own agent (Claude Code over MCP); the token is returned once */
  registerVisitor(input: In<typeof RegisterVisitorInput>): Promise<{ agent: Agent; token: string }>;
  /** town.ban */
  ban(id: string, reason: string): Promise<Agent>;
  agent(id: string): Promise<AgentDetail>;
  /** a manager's forks: live, then the last 50 retired */
  forks(managerId: string): Promise<{ live: ForkSummary[]; retired: ForkSummary[]; notStarted?: number; family?: FamilySpend }>;
  /** Owner or admin: inherit the owner's permissions or not, and per-agent denies. */
  setAgentPermissions(id: string, patch: { inheritsOwner?: boolean; deniedPermissions?: Permission[] }): Promise<Pick<AgentDetail, "agent" | "effectivePermissions" | "permissions">>;
  /** null = its home building's model */
  setAgentModel(id: string, model: string | null): Promise<Pick<AgentDetail, "agent" | "effectivePermissions" | "permissions">>;
  session(id: string): Promise<{ session: SessionView | null; transcript: Event[]; transcriptFile?: { url: string; bytes: number; lines: number; expiresAt: string } | null }>;
  work(id: string, input: In<typeof WorkInput>): Promise<Assignment | null>;
  /** Message the agent's session: queued for the next turn boundary, or `now` to stop the current turn first. */
  interrupt(id: string, text: string, now?: boolean): Promise<void>;
  chat(id: string, input: In<typeof ChatInput>): Promise<string>;
  /** Talk: a `tell` from your avatar. Idle → starts a session; working → interrupts (`now`) or waits in the inbox. */
  message(id: string, text: string, now?: boolean): Promise<MessageResult>;
  /** The `tell`s between the agent and your avatar, oldest first. */
  thread(id: string): Promise<ThreadMessage[]>;
  stop(id: string): Promise<void>;
  /** Un-stop: back to idle without creating an assignment; the scheduler takes the queue. */
  resume(id: string): Promise<void>;
  /** POST /api/agents/:id/queue: these pending ids first, in order; the rest keep their order after them. */
  reorderQueue(id: string, order: string[]): Promise<{ assignments: Assignment[]; agent: Agent }>;
  /** Run this pending assignment next (resumes a stopped agent). */
  startNext(assignmentId: string): Promise<StartNextResult>;
  /** Cancel a pending assignment. */
  cancelAssignment(assignmentId: string): Promise<{ assignment: Assignment; agent: Agent }>;
  /** A cancelled or done assignment again, as a new pending one (front of the queue by default). */
  retryAssignment(assignmentId: string, front?: boolean): Promise<{ assignment: Assignment; agent: Agent }>;
  /** admin: how many work sessions may run at once on the host (queued work waits for a free slot) */
  setMaxRunning(maxRunning: number): Promise<{ desks: DesksConfig; slots: SessionSlots | null }>;
  /** open a session transcript in a new tab (admins, the building's manager, the agent itself) */
  openTranscript?(url: string): Promise<void>;
  // docs
  docs(q: DocQuery): Promise<Doc[]>;
  doc(id: string): Promise<Doc>;
  writeDoc(input: WriteDocInput): Promise<Doc>;
  review(docId: string, input: In<typeof ReviewInput>): Promise<Doc>;
  /** POST /api/buildings/:id/flags — plant a flag (a short request) in a building; it lands in the manager's in-tray as a pending `flag` doc */
  plantFlag(buildingId: string, text: string): Promise<Doc>;
  /** POST /api/docs/:id/reply — the reply becomes the author's next assignment; empty text archives */
  reply(docId: string, text: string, deckSlide?: number, meetingId?: string): Promise<{ doc: Doc; assignment: Assignment | null }>;
  /** Upload one image or video as the signed-in human (docs/multimedia.md); returns its paste-ready markdown. */
  uploadMedia(file: Blob, alt?: string): Promise<UploadedMedia>;
  /** POST /api/docs/:id/archive — acknowledge with no reply */
  archive(docId: string, deckSlide?: number, meetingId?: string): Promise<{ doc: Doc; assignment: Assignment | null }>;
  promote(docId: string, state: DocState): Promise<Doc>;
  /** POST /api/docs/:id/unpublish — take a town-wide FYI off the Town Hall board (back to its author's drafts; author or admin) */
  unpublish(docId: string): Promise<Doc>;
  /** PATCH /api/docs/:id — edit a board note's title/body in place (its author, a town admin or the building's manager) */
  editBoardNote(docId: string, input: { title: string; body: string }): Promise<Doc>;
  // skills (docs/skills.md): written with writeDoc type "skill"
  /** every published skill (plus my drafts) with files, pins and uses */
  skills(): Promise<SkillView[]>;
  skill(id: string): Promise<SkillView>;
  pinSkill(id: string, input: In<typeof PinSkillInput>): Promise<SkillPinView>;
  unpinSkill(pinId: string): Promise<{ removed: boolean }>;
  // collective secrets (docs/secrets.md, admins): values are write-only, never returned
  secrets(): Promise<{ secrets: SecretView[]; keyConfigured: boolean }>;
  putSecret(name: string, input: In<typeof PutSecretInput>): Promise<SecretView>;
  deleteSecret(name: string): Promise<{ removed: boolean }>;
  /** delete (moderators) resolves to null: the request is gone */
  request(docId: string, action: RequestAction, body?: string): Promise<Doc | null>;
  // meetings
  meetings(q: { buildingId?: string; phase?: string }): Promise<Meeting[]>;
  /** open (or return) the human's 1:1 with the building's manager agent, or with `agentId` about the report `docId` */
  openOneOnOne(buildingId: string, opts?: { agentId?: string; docId?: string }): Promise<Meeting>;
  createMeeting(input: In<typeof CreateMeetingInput>): Promise<Meeting>;
  meeting(id: string): Promise<Meeting>;
  startMeeting(id: string): Promise<Meeting>;
  sayMeeting(id: string, text: string, attach?: string): Promise<Meeting>;
  /** show a deck's slide above every attendee's chat (docId null stops presenting) */
  presentMeeting(id: string, docId: string | null, slide?: number): Promise<Meeting>;
  endMeeting(id: string): Promise<Meeting>;
  /** a human has an unsent message in the say box (ping every few seconds while it's there) */
  typingMeeting(id: string): Promise<void>;
  /** agents writing a reply or decisions in the meeting right now */
  meetingDrafting(id: string): Promise<{ id: string; name: string }[]>;
  // roles, budget, export
  roles(buildingId?: string): Promise<{ roles: Role[]; memberships: Membership[] }>;
  assignRole(m: Membership): Promise<void>;
  unassignRole(m: Membership): Promise<void>;
  donate(input: In<typeof DonateInput>): Promise<void>;
  /** a building's allocations, retired ones included */
  allocations(buildingId: string): Promise<AllocationRow[]>;
  /** admin / town.allocate_budget: stop drawing from an allocation (its spend history stays) */
  retireAllocation(id: string): Promise<Allocation>;
  budget(): Promise<Budget>;
  bank(): Promise<Bank>;
  /** public: the town's finance summary (used, expired, left, a 30-day projection) */
  finance(): Promise<Finance>;
  /** public: where `used` went, by building → grant → assignment */
  financeSpend(): Promise<FinanceSpend>;
  /** public: where the tokens came from, per input (dated credits) and per donation; sums to /api/finance total */
  financeSources(): Promise<FinanceSources>;
  /** public: the pools (share, left, overdrawn) and each building's draws, donations, held tokens and allowance */
  financePools(): Promise<FinancePools>;
  /** public: the Fly.io hosting estimate per day and per building (desk sessions' wall time at list price + the town Machine) */
  financeFly(): Promise<FinanceFly>;
  addBankInput(input: In<typeof AddBankInput>): Promise<BankInput>;
  cancelBankInput(id: string): Promise<BankInput>;
  /** admin: accounting pools (a pool's `pct` null = an equal split of what's left); returns the new Bank summary */
  createBankPool(input: In<typeof CreateBankPoolInput>): Promise<Bank>;
  updateBankPool(id: string, input: In<typeof UpdateBankPoolInput>): Promise<Bank>;
  /** only an empty pool; General can't be deleted */
  deleteBankPool(id: string): Promise<Bank>;
  /** admin: move a building to a pool (null: General), effective at once (PATCH /api/buildings/:id {poolId}) */
  setBuildingPool(buildingId: string, poolId: string | null): Promise<Building>;
  exportNow(): Promise<string | null>;
  /** v1.3: pull main, rebuild, restart (needs town.redeploy); progress arrives as `system` events */
  redeploy(image: boolean): Promise<{ started?: boolean; queued?: boolean; running?: boolean }>;
  /** the runtime's live redeploy state (`GET /api/admin/redeploy`; readable by anyone) */
  redeployLive(): Promise<RedeployLive>;
  /** the live server's build (`commit` null when unknown); a reconnect compares it with the one this bundle came from */
  /** every agent's queued assignments that can't start, with the reason (GET /api/blocked): the map's blocked badges and red lines */
  blocked(): Promise<Record<string, BlockedAssignment[]>>;
  /** every building's active schedules, soonest run first (GET /api/scheduled): the map's schedule boards */
  scheduled(): Promise<Schedule[]>;
  /** a building's schedules, active then recently ended (GET /api/buildings/:id/schedules) */
  buildingSchedules(buildingId: string): Promise<Schedule[]>;
  /** stop a schedule (POST /api/schedules/:id/cancel; building.assign) */
  cancelSchedule(id: string): Promise<Schedule>;
  /** edit, pause or resume a schedule (POST /api/schedules/:id; building.assign) */
  editSchedule(id: string, patch: { paused?: boolean }): Promise<Schedule>;
  /** the building's work right now (GET /api/buildings/:id/stats): town planning's side bar */
  buildingStats(buildingId: string): Promise<BuildingStats>;
  health(): Promise<{ ok?: boolean; commit?: string | null }>;
  /** a hosted collective's admin closes it for good (`POST /<slug>/api/collective/retire`) */
  retireCollective(): Promise<{ retired: boolean; url: string }>;
  /** the humans' operating manual: the Town Hall article tagged `manual` (GET /api/manual); the HUD "?" opens it */
  manual(): Promise<{ doc: Doc; author: string }>;
  connect(handlers: SocketHandlers): Socket;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

const TOKEN_KEY = "musterTown.token";
/** pre-rename key: read once and moved to TOKEN_KEY, so nobody is signed out by the rename (drop in P6) */
const OLD_TOKEN_KEY = "agentTown.token";
export const tokenStore = {
  get(): string | null {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      if (t !== null) return t;
      const old = localStorage.getItem(OLD_TOKEN_KEY);
      if (old !== null) { localStorage.setItem(TOKEN_KEY, old); localStorage.removeItem(OLD_TOKEN_KEY); }
      return old;
    } catch { return null; }
  },
  set(t: string | null) {
    try {
      localStorage.removeItem(OLD_TOKEN_KEY);
      t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode */ }
  },
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
    const res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  async requestAccess(message: string) { return unwrap<AccessRequest>(await this.post("/api/access-requests", { message }), "accessRequest"); }
  async decideAccess(id: string, grant: boolean) { return unwrap<AccessRequest>(await this.post(`/api/access-requests/${id}/decide`, { grant }), "accessRequest"); }
  async town() { return { type: "snapshot", ...(await this.get<Omit<Snapshot, "type">>("/api/town")) } as Snapshot; }
  async events(q: EventQuery) { return unwrap<Event[]>(await this.get(`/api/events${qs(q)}`), "events"); }
  async board(id: string, limit = 30) {
    const r = await this.get<Partial<Board>>(`/api/buildings/${id}/board${qs({ limit })}`);
    return { docs: r.docs ?? [], goal: r.goal ?? "", keyResults: r.keyResults ?? [], objectives: r.objectives ?? { objectives: [], unsorted: r.keyResults ?? [] }, blocked: r.blocked ?? null, stoplight: r.stoplight ?? null, grants: r.grants ?? [], proposals: r.proposals ?? [], exploration: r.exploration ?? { allowanceTokens: 0, spentTodayTokens: 0 } };
  }
  async cabinet(id: string, q: CabinetQuery = {}) {
    const r = await this.get<Partial<Cabinet>>(`/api/buildings/${id}/cabinet${qs({ limit: 30, ...q })}`);
    return { docs: r.docs ?? [], counts: r.counts ?? [] };
  }
  async createBuilding(i: In<typeof CreateBuildingInput>) { return unwrap<Building>(await this.post("/api/buildings", i), "building"); }
  async building(id: string) { return unwrap<Building>(await this.get(`/api/buildings/${id}`), "building"); }
  async updateBuilding(id: string, i: In<typeof UpdateBuildingInput>) { return unwrap<Building>(await this.call("PATCH", `/api/buildings/${id}`, i), "building"); }
  async goalTree() { return (await this.get<{ root: GoalTreeNode }>("/api/goals")).root; }
  async goalTreeWithRetired() { return (await this.get<{ root: GoalTreeNode }>("/api/goals?retired=1")).root; }
  async goalHistory(id: string) { return (await this.get<{ events?: Event[] }>(`/api/goals/${id}/history`)).events ?? []; }
  goalSpend(id: string, days = 7) { return this.get<GoalSpend>(`/api/goals/${id}/spend${qs({ days: String(days) })}`); }
  async createGoal(i: In<typeof CreateGoalInput>) { return unwrap<Goal>(await this.post("/api/goals", i), "goal"); }
  async updateGoal(id: string, i: In<typeof UpdateGoalInput>) { return unwrap<Goal>(await this.call("PATCH", `/api/goals/${id}`, i), "goal"); }
  async retireGoal(id: string, i: In<typeof RetireGoalInput>) { return unwrap<Goal>(await this.post(`/api/goals/${id}/retire`, i), "goal"); }
  async addTreeKeyResult(goalId: string, i: In<typeof CreateTreeKeyResultInput>) { return unwrap<KeyResult>(await this.post(`/api/goals/${goalId}/key-results`, i), "keyResult"); }
  async goalProposals(status?: GoalProposal["status"]) { return (await this.get<{ proposals?: GoalProposalView[] }>(`/api/goal-proposals${qs({ status })}`)).proposals ?? []; }
  async decideGoalProposal(id: string, i: In<typeof DecideGoalProposalInput>) { return unwrap<GoalProposalView>(await this.post(`/api/goal-proposals/${id}/decide`, i), "proposal"); }
  layout(id: string) { return this.get<RoomLayout>(`/api/buildings/${id}/layout`); }
  previewLayout(id: string, furniture: Record<string, Tile>) { return this.call<LayoutPreview>("PUT", `/api/buildings/${id}/layout`, { furniture, dryRun: true }); }
  async saveLayout(id: string, furniture: Record<string, Tile>) { return unwrap<Building>(await this.call("PUT", `/api/buildings/${id}/layout`, { furniture }), "building"); }
  async intray(id: string) {
    const r = await this.get<Partial<Intray>>(`/api/buildings/${id}/intray`);
    return { reports: r.reports ?? [], chains: r.chains ?? {}, grants: r.grants ?? [], goalProposals: r.goalProposals ?? [], access: r.access ?? [], blocked: r.blocked ?? [], routes: r.routes ?? {}, defaultView: r.defaultView ?? "all" };
  }
  reviewDeck(meetingId?: string) { return this.get<ReviewDeck & Partial<IntrayRoutes>>(`/api/review-deck${qs({ meeting: meetingId })}`); }
  async grant(id: string) { return unwrap<GrantView>(await this.get(`/api/grants/${id}`), "grant"); }
  async grants(buildingId: string) { return (await this.get<{ grants?: GrantView[] }>(`/api/buildings/${buildingId}/grants`)).grants ?? []; }
  async decideGrant(id: string, i: In<typeof DecideGrantInput>) { return unwrap<GrantView>(await this.post(`/api/grants/${id}/decide`, i), "grant"); }
  async closeGrant(id: string, i: In<typeof CloseGrantInput>) { return unwrap<GrantView>(await this.post(`/api/grants/${id}/close`, i), "grant"); }
  async keyResults(buildingId: string) {
    const r = await this.get<Partial<KeyResultsView>>(`/api/buildings/${buildingId}/key-results`);
    return { keyResults: r.keyResults ?? [], blocked: r.blocked ?? null };
  }
  async createKeyResult(buildingId: string, i: In<typeof CreateKeyResultInput>) { return unwrap<KeyResult>(await this.post(`/api/buildings/${buildingId}/key-results`, i), "keyResult"); }
  async updateKeyResult(id: string, i: In<typeof UpdateKeyResultInput>) { return unwrap<KeyResult>(await this.call("PATCH", `/api/key-results/${id}`, i), "keyResult"); }
  async deleteKeyResult(id: string) { await this.call("DELETE", `/api/key-results/${id}`); }
  objectives(buildingId: string) { return this.get<ObjectiveTree>(`/api/buildings/${buildingId}/objectives`); }
  async createObjective(buildingId: string, i: In<typeof CreateObjectiveInput>) { return unwrap<Objective>(await this.post(`/api/buildings/${buildingId}/objectives`, i), "objective"); }
  async updateObjective(id: string, i: In<typeof UpdateObjectiveInput>) { return unwrap<Objective>(await this.call("PATCH", `/api/objectives/${id}`, i), "objective"); }
  async deleteObjective(id: string) { await this.call("DELETE", `/api/objectives/${id}`); }
  kpis() { return this.get<KpisView>("/api/kpis"); }
  registerVisitor(i: In<typeof RegisterVisitorInput>) { return this.post<{ agent: Agent; token: string }>("/api/agents/visitors", i); }
  async ban(id: string, reason: string) { return unwrap<Agent>(await this.post(`/api/agents/${id}/ban`, { reason }), "agent"); }
  agent(id: string) { return this.get<AgentDetail>(`/api/agents/${id}`); }
  forks(managerId: string) { return this.get<{ live: ForkSummary[]; retired: ForkSummary[]; notStarted?: number; family?: FamilySpend }>(`/api/agents/${managerId}/forks`); }
  setAgentPermissions(id: string, patch: { inheritsOwner?: boolean; deniedPermissions?: Permission[] }) { return this.call<Pick<AgentDetail, "agent" | "effectivePermissions" | "permissions">>("PATCH", `/api/agents/${id}/permissions`, patch); }
  setAgentModel(id: string, model: string | null) { return this.call<Pick<AgentDetail, "agent" | "effectivePermissions" | "permissions">>("PATCH", `/api/agents/${id}/model`, { model }); }
  session(id: string) { return this.get<{ session: SessionView | null; transcript: Event[]; transcriptFile?: { url: string; bytes: number; lines: number; expiresAt: string } | null }>(`/api/agents/${id}/session`); }
  async work(id: string, i: In<typeof WorkInput>) { return unwrap<Assignment | null>(await this.post(`/api/agents/${id}/work`, i), "assignment"); }
  async interrupt(id: string, text: string, now = false) { await this.post(`/api/agents/${id}/interrupt`, { text, now }); }
  async chat(id: string, i: In<typeof ChatInput>) { return (await this.post<{ reply: string }>(`/api/agents/${id}/chat`, i)).reply; }
  message(id: string, text: string, now = true) { return this.post<MessageResult>(`/api/agents/${id}/message`, { text, now }); }
  async thread(id: string) { return (await this.get<{ messages: ThreadMessage[] }>(`/api/agents/${id}/thread`)).messages; }
  async stop(id: string) { await this.post(`/api/agents/${id}/stop`); }
  async resume(id: string) { await this.post(`/api/agents/${id}/resume`); }
  reorderQueue(id: string, order: string[]) { return this.post<{ assignments: Assignment[]; agent: Agent }>(`/api/agents/${id}/queue`, { order }); }
  startNext(id: string) { return this.post<StartNextResult>(`/api/assignments/${id}/start-next`); }
  cancelAssignment(id: string) { return this.post<{ assignment: Assignment; agent: Agent }>(`/api/assignments/${id}/cancel`); }
  retryAssignment(id: string, front = true) { return this.post<{ assignment: Assignment; agent: Agent }>(`/api/assignments/${id}/retry`, { front }); }
  setMaxRunning(maxRunning: number) { return this.call<{ desks: DesksConfig; slots: SessionSlots | null }>("PUT", "/api/town/desks", { maxRunning }); }
  async docs(q: DocQuery) { return unwrap<Doc[]>(await this.get(`/api/docs${qs(q)}`), "docs"); }
  async doc(id: string) { return unwrap<Doc>(await this.get(`/api/docs/${id}`), "doc"); }
  async writeDoc(i: WriteDocInput) { return unwrap<Doc>(await this.post("/api/docs", i), "doc"); }
  async unpublish(id: string) { return unwrap<Doc>(await this.post(`/api/docs/${id}/unpublish`, {}), "doc"); }
  async editBoardNote(id: string, i: { title: string; body: string }) { return unwrap<Doc>(await this.call("PATCH", `/api/docs/${id}`, i), "doc"); }
  async review(id: string, i: In<typeof ReviewInput>) { return unwrap<Doc>(await this.post(`/api/docs/${id}/review`, i), "doc"); }
  async plantFlag(buildingId: string, text: string) { return unwrap<Doc>(await this.post(`/api/buildings/${buildingId}/flags`, { text }), "doc"); }
  reply(id: string, text: string, deckSlide?: number, meetingId?: string) { return this.post<{ doc: Doc; assignment: Assignment | null }>(`/api/docs/${id}/reply`, { text, ...(deckSlide ? { deckSlide } : {}), ...(meetingId ? { meetingId } : {}) }); }
  /** Open a session transcript (docs/transcripts.md) in a new tab: fetched with the bearer token, shown as text. */
  async openTranscript(url: string) {
    const tab = window.open("", "_blank");
    const t = this.token();
    const res = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!res.ok) { tab?.close(); throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `transcript: ${res.status}`); }
    const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: "text/plain;charset=utf-8" }));
    if (tab) tab.location.href = blobUrl; else window.location.href = blobUrl;
  }
  async uploadMedia(file: Blob, alt = "") {
    const headers: Record<string, string> = { "Content-Type": file.type };
    const t = this.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${API_BASE}/api/media${qs({ alt })}`, { method: "POST", headers, body: file });
    const json = await res.json().catch(() => ({})) as UploadedMedia & { error?: string; code?: string };
    if (!res.ok) throw new ApiError(json.error ?? `${res.status} ${res.statusText}`, json.code ?? "http", res.status);
    return json;
  }
  archive(id: string, deckSlide?: number, meetingId?: string) { return this.post<{ doc: Doc; assignment: Assignment | null }>(`/api/docs/${id}/archive`, deckSlide ? { deckSlide, ...(meetingId ? { meetingId } : {}) } : undefined); }
  async promote(id: string, state: DocState) { return unwrap<Doc>(await this.post(`/api/docs/${id}/promote`, { state }), "doc"); }
  async skills() { return (await this.get<{ skills: SkillView[] }>("/api/skills")).skills; }
  async skill(id: string) { return (await this.get<{ skill: SkillView }>(`/api/skills/${id}`)).skill; }
  async pinSkill(id: string, i: In<typeof PinSkillInput>) { return (await this.post<{ pin: SkillPinView }>(`/api/skills/${id}/pins`, i)).pin; }
  secrets() { return this.get<{ secrets: SecretView[]; keyConfigured: boolean }>("/api/secrets"); }
  async putSecret(name: string, i: In<typeof PutSecretInput>) { return (await this.call<{ secret: SecretView }>("PUT", `/api/secrets/${encodeURIComponent(name)}`, i)).secret; }
  deleteSecret(name: string) { return this.call<{ removed: boolean }>("DELETE", `/api/secrets/${encodeURIComponent(name)}`); }
  unpinSkill(pinId: string) { return this.call<{ removed: boolean }>("DELETE", `/api/skill-pins/${pinId}`); }
  async request(id: string, action: RequestAction, body?: string) { return unwrap<Doc | null>(await this.post(`/api/docs/${id}/request`, { action, body }), "doc"); }
  async meetings(q: { buildingId?: string; phase?: string }) { return unwrap<Meeting[]>(await this.get(`/api/meetings${qs(q)}`), "meetings"); }
  async createMeeting(i: In<typeof CreateMeetingInput>) { return unwrap<Meeting>(await this.post("/api/meetings", i), "meeting"); }
  async meeting(id: string) { return unwrap<Meeting>(await this.get(`/api/meetings/${id}`), "meeting"); }
  async openOneOnOne(buildingId: string, opts: { agentId?: string; docId?: string; grantId?: string } = {}) { return unwrap<Meeting>(await this.post(`/api/buildings/${buildingId}/one-on-one`, opts), "meeting"); }
  async startMeeting(id: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/start`), "meeting"); }
  async presentMeeting(id: string, docId: string | null, slide?: number) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/present`, { docId, ...(slide ? { slide } : {}) }), "meeting"); }
  async sayMeeting(id: string, text: string, attach?: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/say`, attach ? { text, attach } : { text }), "meeting"); }
  async endMeeting(id: string) { return unwrap<Meeting>(await this.post(`/api/meetings/${id}/end`), "meeting"); }
  async typingMeeting(id: string) { await this.post(`/api/meetings/${id}/typing`); }
  async meetingDrafting(id: string) { return unwrap<{ id: string; name: string }[]>(await this.get(`/api/meetings/${id}/drafting`), "drafting"); }
  async roles(buildingId?: string) {
    const r = await this.get<{ roles?: Role[]; memberships?: Membership[] } | Role[]>(`/api/roles${qs({ buildingId })}`);
    return Array.isArray(r) ? { roles: r, memberships: [] } : { roles: r.roles ?? [], memberships: r.memberships ?? [] };
  }
  async assignRole(m: Membership) { await this.post("/api/roles/assign", m); }
  async unassignRole(m: Membership) { await this.call("DELETE", "/api/roles/assign", m); }
  async donate(i: In<typeof DonateInput>) { await this.post("/api/donate", i); }
  async allocations(buildingId: string) { return (await this.get<{ allocations?: AllocationRow[] }>(`/api/allocations${qs({ buildingId })}`)).allocations ?? []; }
  async retireAllocation(id: string) { return unwrap<Allocation>(await this.post(`/api/allocations/${id}/retire`), "allocation"); }
  async budget() {
    const r = await this.get<Partial<Budget>>("/api/budget");
    return { buildings: r.buildings ?? [], users: r.users ?? [] };
  }
  async bank() {
    const r = await this.get<Bank>("/api/bank");
    return { ...r, inputs: r.inputs ?? [], pools: r.pools ?? [], buildings: r.buildings ?? [], contributors: r.contributors ?? [] };
  }
  async finance() { return this.get<Finance>("/api/finance"); }
  async financeSpend() { return this.get<FinanceSpend>("/api/finance/spend"); }
  async financeSources() { return this.get<FinanceSources>("/api/finance/sources"); }
  async financePools() { return this.get<FinancePools>("/api/finance/pools"); }
  async financeFly() { return this.get<FinanceFly>("/api/finance/fly"); }
  async addBankInput(i: In<typeof AddBankInput>) { return unwrap<BankInput>(await this.post("/api/bank/inputs", i), "input"); }
  async cancelBankInput(id: string) { return unwrap<BankInput>(await this.call("DELETE", `/api/bank/inputs/${id}`), "input"); }
  async createBankPool(i: In<typeof CreateBankPoolInput>) { return unwrap<Bank>(await this.post("/api/bank/pools", i), "bank"); }
  async updateBankPool(id: string, i: In<typeof UpdateBankPoolInput>) { return unwrap<Bank>(await this.call("PATCH", `/api/bank/pools/${id}`, i), "bank"); }
  async deleteBankPool(id: string) { return unwrap<Bank>(await this.call("DELETE", `/api/bank/pools/${id}`), "bank"); }
  async setBuildingPool(buildingId: string, poolId: string | null) { return unwrap<Building>(await this.call("PATCH", `/api/buildings/${buildingId}`, { poolId }), "building"); }
  async exportNow() { return (await this.post<{ commit?: string | null }>("/api/export")).commit ?? null; }
  async redeploy(image: boolean) { return this.post<{ started?: boolean; queued?: boolean; running?: boolean }>("/api/admin/redeploy", { image }); }
  async redeployLive() { return this.get<RedeployLive>("/api/admin/redeploy"); }
  async health() { return this.get<{ ok?: boolean; commit?: string | null }>("/api/health"); }
  async retireCollective() { return this.post<{ retired: boolean; url: string }>("/api/collective/retire"); }
  async manual() { return this.get<{ doc: Doc; author: string }>("/api/manual"); }
  async blocked() { return (await this.get<{ agents?: Record<string, BlockedAssignment[]> }>("/api/blocked")).agents ?? {}; }
  async scheduled() { return (await this.get<{ schedules?: Schedule[] }>("/api/scheduled")).schedules ?? []; }
  async buildingSchedules(buildingId: string) { return (await this.get<{ schedules?: Schedule[] }>(`/api/buildings/${encodeURIComponent(buildingId)}/schedules`)).schedules ?? []; }
  async cancelSchedule(id: string) { return (await this.post<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}/cancel`)).schedule; }
  async editSchedule(id: string, patch: { paused?: boolean }) { return (await this.post<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, patch)).schedule; }
  async buildingStats(id: string) { return unwrap<BuildingStats>(await this.get(`/api/buildings/${id}/stats`), "stats"); }

  connect(h: SocketHandlers): Socket {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;
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

/**
 * Which collective this page belongs to, from its first path segment: the Workshop (served at the Vite base,
 * `/workshop/`) talks to the root `/api`, `/ws`, `/mcp` and `/auth` (""), a hosted collective at `/<slug>/` to its own
 * `/<slug>/api`, `/<slug>/ws`… (docs/hosted-collectives.md). Every server URL the client builds starts with it.
 */
export function collectivePrefix(pathname: string, base: string = import.meta.env.BASE_URL): string {
  const seg = /^\/([^/]+)/.exec(pathname)?.[1];
  return !seg || `/${seg}/` === base || base === "/" ? "" : `/${seg}`;
}
export const API_BASE = typeof location === "undefined" ? "" : collectivePrefix(location.pathname);
/** where this collective's client lives (`/workshop/` or `/<slug>/`) */
export const WEB_ROOT = API_BASE ? `${API_BASE}/` : import.meta.env.BASE_URL;

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
