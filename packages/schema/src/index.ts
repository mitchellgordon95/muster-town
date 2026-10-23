/**
 * @muster-town/schema — the single source of truth for world state, documents,
 * events, verbs, and API payloads. Server, runtime, web client, CLI and MCP
 * tools all import from here. If it isn't in this file, it isn't in the contract.
 */
import { z } from "zod";

// ---------- primitives ----------
export const Id = z.string().min(1);
export const Iso = z.string().datetime({ offset: true }).or(z.string().datetime());
export const Tile = z.object({ x: z.number().int(), y: z.number().int() });
export type Tile = z.infer<typeof Tile>;

// ---------- town ----------
/** The collective's code repo: residents of buildings with code access edit it on a per-agent branch, with scoped tools. */
export const Workspace = z.object({
  /** repo root; relative paths resolve from the Muster Town repo root */
  path: z.string(),
  /** Claude Code tool permission patterns added to allowedTools for work sessions */
  tools: z.array(z.string()).default([
    "Read", "Write", "Edit", "Glob", "Grep",
    "Bash(git:*)", "Bash(gh:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)",
    "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(sed:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(wc:*)", "Bash(head:*)", "Bash(tail:*)",
  ]),
  /** branches are named <branchPrefix>/<agent>/<slug> */
  branchPrefix: z.string().default("agent"),
  /** base branch to fork worktrees from */
  base: z.string().default("main"),
  /** clone URL desks use (set at seed from `git remote get-url origin` of `path`, or given directly) */
  repoUrl: z.string().optional(),
});
export type Workspace = z.infer<typeof Workspace>;

export const Town = z.object({
  name: z.string(),
  goal: z.string(),
  tagline: z.string().default(""),
  goalNote: z.string().optional(),
  /** the collective's repo; every building with `codeAccess` works on it (there are no per-building repos) */
  workspace: Workspace.optional(),
});
export type Town = z.infer<typeof Town>;

// ---------- users (humans: donors, managers, visitors' owners) ----------
export const User = z.object({
  id: Id,
  name: z.string(),
  createdAt: Iso,
  /** tokens this user has donated in total (sum of allocations) */
  donatedTokens: z.number().int().nonnegative().default(0),
  /** whether an Anthropic API key is stored for this user (never expose the key) */
  hasApiKey: z.boolean().default(false),
  /** GitHub login (set when the user signed in with GitHub) */
  githubLogin: z.string().optional(),
  /** GitHub numeric user id: the stable key for GitHub sign-in */
  githubId: z.number().int().optional(),
  avatarUrl: z.string().optional(),
});
export type User = z.infer<typeof User>;

// ---------- roles & permissions (Discord-style) ----------
export const Permission = z.enum([
  "town.manage_buildings",   // create/resize/delete buildings, set headcount
  "town.manage_roles",       // create roles, assign roles at town scope
  "town.allocate_budget",    // move donated tokens between buildings
  "town.approve_trophy",     // accept a trophy proposal
  "town.approve_request",    // make an outbox request visible to humans
  "town.ban",                // ban an agent (town-wide; misuse prevention)
  "town.moderate",           // moderator station: review requests, trophy proposals, bans
  "town.redeploy",           // pull main on the host, rebuild, restart the collective's server
  "building.manage",         // edit goal/description/policies, assign building roles
  "building.assign",         // create assignments for agents in the building
  "building.review",         // acknowledge/continue/redirect/stop reports (the in-tray)
  "building.dismiss",        // dismiss (retire) a resident of the building
  "building.promote",        // promote a doc from building -> library
  "building.fund",           // fund / counter / reject grant proposals, decide checkpoints, mark key results met/missed (never effective for agents)
  "doc.write_building",      // publish own docs to the building board
  "doc.propose_trophy",
  "doc.request_human",
  "meeting.facilitate",
  "meeting.attend",
]);
export type Permission = z.infer<typeof Permission>;

export const RoleScope = z.enum(["town", "building"]);
export const Role = z.object({
  id: Id,
  name: z.string(),
  scope: RoleScope,
  buildingId: Id.optional(),  // required when scope === "building"
  permissions: z.array(Permission),
  /** built-in roles can't be deleted */
  builtin: z.boolean().default(false),
});
export type Role = z.infer<typeof Role>;

/** Built-in role names. Instances are created per building for building-scoped ones. */
export const BUILTIN_ROLES = {
  town: {
    admin: Permission.options, // everything
    /** collective-wide misuse prevention; seated at the Town Hall mod station */
    moderator: ["town.approve_trophy", "town.approve_request", "town.ban", "town.moderate"] as Permission[],
    visitor: ["meeting.attend"] as Permission[],
    /** may redeploy the running town from main (workshop residents) */
    deployer: ["town.redeploy"] as Permission[],
  },
  building: {
    manager: [
      "building.manage", "building.assign", "building.review", "building.promote", "building.dismiss", "building.fund",
      "doc.write_building", "doc.propose_trophy", "doc.request_human", "meeting.facilitate", "meeting.attend",
    ] as Permission[],
    /** works the building's in-tray when reviewPolicy is `reviewer` */
    reviewer: ["building.review", "building.assign", "meeting.facilitate", "meeting.attend", "doc.write_building"] as Permission[],
    member: ["doc.write_building", "doc.propose_trophy", "doc.request_human", "meeting.attend"] as Permission[],
  },
} as const;

/** Who holds a role: an agent or a user. */
export const Membership = z.object({
  roleId: Id,
  holderKind: z.enum(["agent", "user"]),
  holderId: Id,
});
export type Membership = z.infer<typeof Membership>;

// ---------- buildings ----------
/** human: the manager works the in-tray; reviewer: the building's reviewer agent does; auto: every report is acknowledged on arrival. */
export const ReviewPolicy = z.enum(["human", "reviewer", "auto"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;
export const MeetingCadence = z.object({
  kind: z.enum(["standup", "retro", "planning"]),
  /** minutes between meetings; 0 = manual only */
  everyMinutes: z.number().int().nonnegative(),
});
export const Lot = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });
export type Lot = z.infer<typeof Lot>;


export const Building = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(["lab", "town-hall"]).default("lab"),
  goal: z.string().default(""),
  description: z.string().default(""),
  /** max resident agents (desks) */
  headcount: z.number().int().positive().default(6),
  reviewPolicy: ReviewPolicy.default("human"),
  /** model for resident work sessions; cheapModel for summaries/proxy chat */
  model: z.string().default("claude-opus-5-5"),
  cheapModel: z.string().default("claude-haiku-5-5"),
  /** safety rail per work session, not a design parameter */
  maxTurnsPerSession: z.number().int().positive().default(80),
  /** tokens each resident may spend per day */
  dailyTokensPerAgent: z.number().int().positive().default(10_000_000),
  meetings: z.array(MeetingCadence).default([]),
  /** standing rules (markdown) from the building's manager; every session in this building starts with them */
  rules: z.string().max(8000).default(""),
  /** the resident a human set as this building's manager: it facilitates meetings and wears a manager badge; null = none set */
  managerAgentId: Id.nullable().default(null),
  /** residents get code tools on the collective's repo (`Town.workspace`) during work sessions */
  codeAccess: z.boolean().default(false),
  /** the Bank pool this building draws from; null = the collective's default pool, General (`DEFAULT_POOL_ID`) */
  poolId: Id.nullable().default(null),
  /** goal-directed budgets: tokens per day for exploration work; null = 10% of its pool's daily inflow */
  explorationTokensPerDay: z.number().int().nonnegative().nullable().default(null),
  /** rollout switch for goal-directed budgets: `open` = today's rules, `goal-directed` = grants and exploration gate sessions */
  budgetMode: z.enum(["open", "goal-directed"]).default("open"),
  /** tile rectangle on the town grid; assigned by the server if absent */
  lot: Lot.optional(),
  /** moved furniture: piece key (`board`, `desk:3`, `meeting`, …) -> anchor tile relative to the lot; absent = default spot */
  furniture: z.record(z.object({ x: z.number().int(), y: z.number().int() })).default({}),
  createdAt: Iso,
  createdBy: Id.optional(),
});
export type Building = z.infer<typeof Building>;

/**
 * How an allocation's sessions authenticate: `subscription` runs on the owner's Claude subscription
 * (CLAUDE_CODE_OAUTH_TOKEN), `api-key` on the collective's ANTHROPIC_API_KEY (paid per use), `donor-key`
 * on the donor's own stored key. Sessions draw subscription first, then donor-key, then api-key.
 */
export const AllocationAuth = z.enum(["subscription", "api-key", "donor-key"]);
export type AllocationAuth = z.infer<typeof AllocationAuth>;

/** Donated tokens allocated to a building from a user's donation. */
export const Allocation = z.object({
  id: Id,
  userId: Id,
  buildingId: Id,
  tokens: z.number().int().positive(),
  spentTokens: z.number().int().nonnegative().default(0),
  spentUsd: z.number().nonnegative().default(0),
  createdAt: Iso,
  auth: AllocationAuth.default("api-key"),
  /** what it is, in the donor's words (e.g. "Mitchell's Claude subscription, October") */
  label: z.string().default(""),
  /** retired: kept for its spend history, but never drawn from and left out of the building's budget */
  retired: z.boolean().default(false),
});
export type Allocation = z.infer<typeof Allocation>;

/** Where a Bank input's tokens come from: someone's API key, or the owner's own subscription. */
export const BankSource = z.enum(["api-key", "subscription"]);
export type BankSource = z.infer<typeof BankSource>;
/** How often an input credits the Bank: once when added, or on each renewal. */
export const BankRecurrence = z.enum(["once", "daily", "weekly", "monthly"]);
export type BankRecurrence = z.infer<typeof BankRecurrence>;
/**
 * An input to the town Bank. A one-time input credits once when added; a recurring one credits
 * `tokens` on each renewal (`nextCreditAt`). A subscription credits daily, at most `weeklyCapTokens`
 * per 7 days. The API key is a secret column, never part of this object.
 */
export const BankInput = z.object({
  id: Id,
  userId: Id,
  label: z.string(),
  source: BankSource,
  model: z.string(),
  tokens: z.number().int().positive(),
  recurrence: BankRecurrence,
  weeklyCapTokens: z.number().int().positive().nullable().default(null),
  /** next renewal; null once a one-time input has credited or the input is cancelled */
  nextCreditAt: Iso.nullable().default(null),
  creditedTokens: z.number().int().nonnegative().default(0),
  hasApiKey: z.boolean().default(false),
  cancelledAt: Iso.nullable().default(null),
  createdAt: Iso,
});
export type BankInput = z.infer<typeof BankInput>;
/** One credit from an input into the Bank. A subscription's credit expires a day later (no rollover); an API key's is durable (`expiresAt` null). */
export const BankCredit = z.object({ id: Id, inputId: Id, tokens: z.number().int().positive(), createdAt: Iso, expiresAt: Iso.nullable().default(null) });
export type BankCredit = z.infer<typeof BankCredit>;
/** The collective's default pool: every building without a `poolId` draws from it. It can't be deleted. */
export const DEFAULT_POOL_ID = "general";
/**
 * An accounting pool: a group of buildings that share one slice of the Bank, first come first served.
 * `pct` is an explicit % of the Bank; pools without one split what's left equally.
 */
export const BankPool = z.object({ id: Id, name: z.string().min(1).max(80), pct: z.number().min(0).max(100).nullable().default(null), createdAt: Iso });
export type BankPool = z.infer<typeof BankPool>;
/**
 * Tokens a building's session drew from the Bank: from an expiring credit (`creditId`), else from the durable credits.
 * `poolId` is the pool it drew from (what the pool's share is charged against); `buildingId` is who spent it.
 */
export const BankDebit = z.object({ id: Id, buildingId: Id, poolId: Id, agentId: Id, creditId: Id.nullable().default(null), tokens: z.number().int().positive(), createdAt: Iso });
export type BankDebit = z.infer<typeof BankDebit>;
/** One charge of model usage: who spent it and which building it counts for (the agent's home). The usage ledger behind tokensToday / tokensAllTime. */
export const UsageEntry = z.object({ id: Id, agentId: Id, buildingId: Id.nullable().default(null), tokens: z.number().int().nonnegative(), usd: z.number().nonnegative().default(0), createdAt: Iso });
export type UsageEntry = z.infer<typeof UsageEntry>;

// ---------- agents (bodies in the world) ----------
export const AgentKind = z.enum(["resident", "visitor", "human", "service"]);
export const AgentStatus = z.enum([
  "idle", "walking", "working", "in-meeting", "out-of-budget", "stopped", "banned",
  /** v1.4: a visitor with no authenticated call in the last 90 s (residents are never offline) */
  "offline",
  /** dismissed: row kept so documents keep their author; hidden from the snapshot */
  "retired",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Agent = z.object({
  id: Id,
  name: z.string(),
  kind: AgentKind,
  /** resident: the building whose desk it occupies; visitor/human: current building or null (outside) */
  buildingId: Id.nullable().default(null),
  /** home building for residents (never changes without a manager) */
  homeBuildingId: Id.nullable().default(null),
  /** owner user (for visitors and humans); residents are owned by the building's manager user */
  ownerUserId: Id.nullable().default(null),
  /** legacy: service agents use `title` as their role label ("Librarian"); prompts use neither. Residents have no title or job description. */
  title: z.string().default(""),
  direction: z.string().default(""),
  sprite: z.number().int().nonnegative().default(0),
  pos: Tile,
  status: AgentStatus.default("idle"),
  /** one line about what it's doing now (server-maintained from events) */
  activity: z.string().default(""),
  model: z.string().nullable().default(null),
  spentTokensToday: z.number().int().nonnegative().default(0),
  spentTokensTotal: z.number().int().nonnegative().default(0),
  spentUsdTotal: z.number().nonnegative().default(0),
  currentAssignmentId: Id.nullable().default(null),
  currentMeetingId: Id.nullable().default(null),
  createdAt: Iso,
  lastActiveAt: Iso.nullable().default(null),
  /** v1.4: last authenticated agent call (MCP tool or /api/verbs), written at most every 10 s; for an offline visitor, when it went quiet */
  lastSeenAt: Iso.nullable().default(null),
  /** v1.5: inherit the owner user's effective permissions (visitors and human avatars default true; residents/service false). Always capped by the owner. */
  inheritsOwner: z.boolean().default(false),
  /** v1.5: permissions removed from this agent's effective set (set by its owner or an admin) */
  deniedPermissions: z.array(Permission).default([]),
});
export type Agent = z.infer<typeof Agent>;

// ---------- places (named points on the map) ----------
export const PlaceKind = z.enum([
  "desk", "door", "library", "trophy-room", "outbox", "meeting-room", "plaza",
  /** board:<buildingId> — wall board inside each lab */
  "board",
  /** cabinet:<buildingId> — filing cabinet beside the board: the building's reports and meeting notes */
  "cabinet",
  /** intray:<buildingId> — the manager's desk (pending reports) */
  "intray",
  /** mod-station — Town Hall desk where town moderators sit */
  "mod-station",
  /** planning-desk — Town Hall: create buildings, add/dismiss residents, roles */
  "planning",
  /** retired: the Town Hall donation box (donating is at the Bank); no layout emits it any more */
  "donation",
  /** schedule-board — Town Hall: upcoming meetings for every building */
  "schedule",
  /** visitor-bench — Town Hall, beside the door: where visitors without a building desk wait */
  "bench",
  /** bank-map — the Bank: a town map; using it zooms out to the whole town and shows the Bank's tokens flowing to each building by share */
  "bank-map",
  /** bank — the teller counter inside the Bank (BANK_LOT, south of the road): the town's token balance */
  "bank",
]);
export type PlaceKind = z.infer<typeof PlaceKind>;
export const Place = z.object({
  id: Id,                 // e.g. "desk:<agentId>", "door:<buildingId>", "library", "meeting-room:<buildingId>", "board:<buildingId>", "cabinet:<buildingId>", "intray:<buildingId>", "mod-station"
  kind: PlaceKind,
  name: z.string(),
  buildingId: Id.nullable(),
  pos: Tile,
});
export type Place = z.infer<typeof Place>;

// ---------- documents (the library) ----------
export const DocType = z.enum([
  "report",        // end-of-session report by an agent
  "source",        // source card for an external source
  "article",       // running article (desk article, synthesis)
  "note",          // anything else an agent writes
  "fyi",           // building-wide FYI: the only type that goes on the building's board
  "meeting-notes",
  "request",       // outbox: a request for a human to do something in the world
  "human-report",  // inbox: a human's report back
  "assignment-proposal", // reserved
  "notebook",      // retired (migration 028 turned notebooks into wiki pages); kept so old events and exports still parse
  "wiki",          // an agent's memory: one private page per topic it knows (title = topic), rewritten before each report, injected into its sessions
  "log",           // an agent's memory: one private append-only log of durable events (assignments, reports, decisions); its tail is injected
  "skill",         // a reusable skill: SKILL.md (frontmatter name + description, then instructions) plus bundled files (docs/skills.md)
]);
export type DocType = z.infer<typeof DocType>;

/** The only types pinned to a building's board (building-wide FYIs). Every other published doc is filed in its filing cabinet. */
export const BOARD_TYPES: readonly DocType[] = ["fyi"];

export const DocState = z.enum(["draft", "building", "library", "trophy"]);
export type DocState = z.infer<typeof DocState>;

export const Verdict = z.enum(["continue", "pivot", "stop"]);
/**
 * pending = in the in-tray. approve = acknowledged (no assignment). continue = acknowledged + assignment from the
 * report's Proposal. redirect = acknowledged + assignment from the manager's note. stop = acknowledged + agent stopped.
 */
export const Decision = z.enum(["pending", "approve", "continue", "redirect", "stop"]);
export type Decision = z.infer<typeof Decision>;
/** Decisions a reviewer can make (everything but pending). */
export const ReviewDecision = z.enum(["approve", "continue", "redirect", "stop"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;
export const RequestStatus = z.enum(["proposed", "approved", "claimed", "done", "rejected"]);

export const Provenance = z.object({
  /** ids of source docs this doc relies on */
  sourceIds: z.array(Id).default([]),
  /** external URLs cited */
  urls: z.array(z.string()).default([]),
});

export const Doc = z.object({
  id: Id,
  type: DocType,
  state: DocState.default("draft"),
  title: z.string(),
  /** markdown */
  body: z.string(),
  authorId: Id,                       // agent id or user id
  authorKind: z.enum(["agent", "user"]),
  buildingId: Id.nullable().default(null),
  provenance: Provenance.default({ sourceIds: [], urls: [] }),
  tags: z.array(z.string()).default([]),
  // report-specific
  verdict: Verdict.optional(),
  decision: Decision.optional(),
  decisionNote: z.string().optional(),
  decidedBy: Id.optional(),
  decidedAt: Iso.optional(),
  sessionId: Id.optional(),
  assignmentId: Id.optional(),
  costUsd: z.number().optional(),
  tokens: z.number().int().optional(),
  /** report-specific: SDK turns of the session that produced it */
  turns: z.number().int().optional(),
  // request-specific (outbox)
  requestStatus: RequestStatus.optional(),
  location: z.string().optional(),
  claimedByUserId: Id.optional(),
  // trophy-specific
  trophyProposedBy: Id.optional(),
  trophyWhy: z.string().optional(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Doc = z.infer<typeof Doc>;

// ---------- collective secrets (docs/secrets.md) ----------
/** Env-var style: A-Z, 0-9, _; starts with a letter. */
export const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an env var name: A-Z, 0-9 and _, starting with a letter (max 64)");
/** Who a secret reaches: a session gets it if its building or agent is listed, or a listed skill is pinned for the agent. */
export const SecretGrants = z.object({
  /** every resident of every building (the whole town); the other grants then add nothing. Absent = false. */
  town: z.boolean().optional(),
  buildings: z.array(Id).default([]),
  agents: z.array(Id).default([]),
  skills: z.array(Id).default([]),
});
export type SecretGrants = z.infer<typeof SecretGrants>;
/** A secret as the API lists it: never the value. */
export const SecretView = z.object({
  name: SecretName,
  grants: SecretGrants,
  /** a value is stored (encrypted) */
  set: z.boolean(),
  updatedAt: Iso,
  updatedBy: Id.nullable(),
});
export type SecretView = z.infer<typeof SecretView>;
/** PUT /api/secrets/:name: set or replace the value (write-only), and/or replace the grants. */
export const PutSecretInput = z.object({
  value: z.string().min(1).max(16_384).optional(),
  grants: SecretGrants.optional(),
});
export type PutSecretInput = z.infer<typeof PutSecretInput>;

// ---------- skills (docs/skills.md) ----------
/** Bundled-file limits per skill: count, chars per file, chars in total. Text files only. */
export const SKILL_LIMITS = { files: 40, fileChars: 100_000, totalChars: 500_000, nameChars: 64, descriptionChars: 300, alwaysChars: 8000 } as const;
/** A bundled file's path inside the skill folder: relative, no `..`, letters/digits/`._-` per segment. */
export const SkillFilePath = z.string().min(1).max(200)
  .regex(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "a relative path like scripts/check.sh (letters, digits, . _ - and /; no ..)")
  .refine((p) => p !== "SKILL.md", "SKILL.md is the skill's body; don't bundle it as a file");
export const SkillFileInput = z.object({ path: SkillFilePath, content: z.string().max(SKILL_LIMITS.fileChars) });
export type SkillFileInput = z.infer<typeof SkillFileInput>;
export const SkillFileInfo = z.object({ path: z.string(), chars: z.number().int(), updatedAt: Iso });
export type SkillFileInfo = z.infer<typeof SkillFileInfo>;

/** agent = one resident's sessions; building = every session in the building; town = every session in the town. */
export const SkillPinScope = z.enum(["agent", "building", "town"]);
export type SkillPinScope = z.infer<typeof SkillPinScope>;
/** listed = name + description in the prompt (the agent `read`s it when needed); always = the full text in the prompt. */
export const SkillPinMode = z.enum(["listed", "always"]);
export type SkillPinMode = z.infer<typeof SkillPinMode>;
export const SkillPin = z.object({
  id: Id,
  skillId: Id,
  scope: SkillPinScope,
  /** agent id (agent scope), building id (building scope), null (town) */
  targetId: Id.nullable(),
  mode: SkillPinMode,
  pinnedBy: Id,
  pinnedByKind: z.enum(["agent", "user"]),
  /** pinned by a human (a human's avatar or a user): needed for pins into others' sessions of skills with files */
  byHuman: z.boolean(),
  createdAt: Iso,
});
export type SkillPin = z.infer<typeof SkillPin>;
/** A pin as listed with its skill: plus who it reaches and whether it is suspended. */
export const SkillPinView = SkillPin.extend({
  targetName: z.string().nullable(),
  pinnedByName: z.string(),
  /** why the pin doesn't load (e.g. files were added after an agent pinned it into others' sessions); null = it loads */
  suspended: z.string().nullable(),
});
export type SkillPinView = z.infer<typeof SkillPinView>;
export const SkillView = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  state: DocState,
  buildingId: Id.nullable(),
  authorId: Id,
  author: z.string(),
  files: z.array(SkillFileInfo),
  pins: z.array(SkillPinView),
  /** `skill.used` events (a session `read` the skill or one of its files) in the last 7 / 30 days */
  uses7d: z.number().int(),
  uses30d: z.number().int(),
  updatedAt: Iso,
});
export type SkillView = z.infer<typeof SkillView>;
export const PinSkillInput = z.object({
  scope: SkillPinScope.default("agent"),
  targetId: Id.optional().describe("scope agent: the agent (default you); scope building: the building (default yours); ignored for town"),
  mode: SkillPinMode.default("listed").describe("listed = name + description in the prompt; always = the full text"),
});
export type PinSkillInput = z.infer<typeof PinSkillInput>;

// ---------- assignments ----------
/**
 * What a pending assignment waits on before the scheduler may start it (a closed set the runtime evaluates):
 * `deploy` = the live server contains this commit ("next" = the server restarted after the assignment was made);
 * `assignment` = that assignment is done or cancelled; `decision` = that report got a decision; `after` = not before this time.
 * Unmet after 24 h, the assignment is cancelled into its building's in-tray.
 */
export const WaitFor = z.union([
  z.object({ deploy: z.string().regex(/^([0-9a-f]{7,40}|next)$/, "a commit sha (7-40 hex chars) or \"next\"").describe("live server contains this commit; \"next\" = after the next redeploy") }).strict(),
  z.object({ assignment: z.string().min(1).describe("that assignment is done or cancelled") }).strict(),
  z.object({ decision: z.string().min(1).describe("that report (doc id) got a decision") }).strict(),
  z.object({ after: Iso.describe("not before this time (ISO, at most 24 h ahead)") }).strict(),
]);
export type WaitFor = z.infer<typeof WaitFor>;
/** How long a wait may stay unmet before the assignment is cancelled into the in-tray. */
export const WAIT_TTL_MS = 24 * 60 * 60_000;
export const AssignmentStatus = z.enum(["pending", "active", "done", "cancelled"]);
export const Assignment = z.object({
  id: Id,
  agentId: Id,
  buildingId: Id,
  title: z.string(),
  description: z.string(),
  status: AssignmentStatus.default("pending"),
  createdBy: Id,              // user or agent id
  createdByKind: z.enum(["agent", "user"]),
  fromMeetingId: Id.nullable().default(null),
  fromReportId: Id.nullable().default(null),
  reportId: Id.nullable().default(null),
  /** retried from this (cancelled or done) assignment */
  fromAssignmentId: Id.nullable().default(null),
  /** queue order among the agent's pending assignments: lower runs first (ties: createdAt, rowid). New ones get epoch ms. */
  position: z.number().default(0),
  /** v1.4: an assignment for a visitor is an offer: the scheduler never starts it; the visitor takes it with `accept_assignment` (clears this). Cancelled after 24 h. */
  offered: z.boolean().optional(),
  /** waits on a dependency: the scheduler skips it until the runtime clears this (met), or cancels it after WAIT_TTL_MS. Start-next overrides. */
  waitFor: WaitFor.nullable().optional(),
  /** P2: parked by its agent's own report (`submit_report` with `resumeWhen`); how many times this chain has parked */
  parked: z.number().int().optional(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Assignment = z.infer<typeof Assignment>;
/** SQL tail for "next pending first": every queue query orders by this. */
export const QUEUE_ORDER = "ORDER BY position, createdAt, rowid";

// ---------- messages (inbox) ----------
export const MessageKind = z.enum(["tell", "heard", "system", "meeting", "mention"]);
export const Message = z.object({
  id: Id,
  kind: MessageKind,
  fromId: Id,                 // agent or user id
  fromKind: z.enum(["agent", "user", "system"]),
  toId: Id,                   // agent id (inbox owner)
  body: z.string(),
  meetingId: Id.nullable().default(null),
  /** mention: the doc the mention is in (read it with `read`) */
  docId: Id.nullable().default(null),
  createdAt: Iso,
  readAt: Iso.nullable().default(null),
});
export type Message = z.infer<typeof Message>;

// ---------- meetings ----------
export const MeetingKind = z.enum(["standup", "retro", "planning", "town-hall"]);
export const MeetingPhase = z.enum(["scheduled", "collecting", "discussing", "done", "cancelled"]);
export const MeetingDecision = z.object({
  text: z.string(),
  assigneeId: Id.nullable().default(null),
  assignmentId: Id.nullable().default(null),
  /** amends an earlier decision of this meeting (its 1-based number in the decisions list): its pending assignment is rewritten or cancelled instead of a second one being created */
  supersedes: z.number().int().positive().optional(),
  /** set on a decision a later one replaced (that decision's 1-based number); kept for the record */
  supersededBy: z.number().int().positive().optional(),
  /** the decision's assignment waits for this before it starts (e.g. {deploy: "next"} for "after the redeploy") */
  waitFor: WaitFor.optional(),
});
export const MeetingUtterance = z.object({
  speakerId: Id,
  speakerKind: z.enum(["agent", "user"]),
  text: z.string(),
  at: Iso,
});
export const Meeting = z.object({
  id: Id,
  kind: MeetingKind,
  buildingId: Id.nullable(),  // null = town-hall
  title: z.string(),
  scheduledAt: Iso,
  phase: MeetingPhase.default("scheduled"),
  facilitatorId: Id.nullable().default(null),
  attendeeIds: z.array(Id).default([]),
  agenda: z.string().default(""),
  /** attendeeId -> short standup summary (did / next / need) submitted before discussion */
  summaries: z.record(z.string()).default({}),
  transcript: z.array(MeetingUtterance).default([]),
  decisions: z.array(MeetingDecision).default([]),
  notesDocId: Id.nullable().default(null),
  createdAt: Iso,
  startedAt: Iso.nullable().default(null),
  endedAt: Iso.nullable().default(null),
});
export type Meeting = z.infer<typeof Meeting>;

// ---------- goal-directed budgets: grants and key results ----------
/** Every session runs in one lane: work on a funded grant, goal-scoped exploration, or work a human asked for directly. */
export const SpendLane = z.enum(["grant", "exploration", "directed"]);
export type SpendLane = z.infer<typeof SpendLane>;
export const GrantStatus = z.enum([
  "draft",       // the manager is writing it
  "proposed",    // waiting for a human
  "countered",   // a human sent it back with changes; the manager's move
  "funded",      // sessions may draw on it
  "checkpoint",  // spend crossed 50% (or 100%): new sessions held until a human decides
  "closed",      // done: see outcome
  "rejected",
]);
export type GrantStatus = z.infer<typeof GrantStatus>;
export const GrantOutcome = z.enum(["met", "stopped", "spent", "cut"]);
export type GrantOutcome = z.infer<typeof GrantOutcome>;
export const GrantAction = z.enum(["propose", "counter", "fund", "reject", "checkpoint", "continue", "adjust", "cut", "close", "edit"]);
export const GrantHistoryEntry = z.object({
  at: Iso,
  byId: Id,
  byKind: z.enum(["agent", "user"]),
  action: GrantAction,
  tokens: z.number().int().nullable().default(null),
  note: z.string().default(""),
});
export type GrantHistoryEntry = z.infer<typeof GrantHistoryEntry>;
/** A building's proposal and, once funded, its grant: one objective, 2-3 key results, a token ceiling (not a reservation). */
export const Grant = z.object({
  id: Id,
  buildingId: Id,
  objective: z.string().min(1).max(300),
  /** when to stop even if tokens remain */
  stopCondition: z.string().min(1).max(500),
  /** tokens asked by the manager (latest revision) */
  askTokens: z.number().int().positive(),
  /** tokens granted by a human; null until funded. A top-up raises it. */
  grantTokens: z.number().int().positive().nullable().default(null),
  status: GrantStatus,
  outcome: GrantOutcome.nullable().default(null),
  /** exploration reports the proposal draws on */
  findingsDocIds: z.array(Id).default([]),
  /** spend fractions already checkpointed (0.5, 1), so each fires once per grantTokens value */
  checkpointsDone: z.array(z.number()).default([]),
  /** the manager's latest checkpoint report */
  checkpointDocId: Id.nullable().default(null),
  proposedBy: Id,
  /** a user id; never an agent */
  fundedBy: Id.nullable().default(null),
  fundedAt: Iso.nullable().default(null),
  closedAt: Iso.nullable().default(null),
  /** the negotiation: every propose / counter / fund / checkpoint decision / close, oldest first */
  history: z.array(GrantHistoryEntry).default([]),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Grant = z.infer<typeof Grant>;
export const KeyResultStatus = z.enum(["not-started", "on-track", "at-risk", "claimed", "met", "missed"]);
export type KeyResultStatus = z.infer<typeof KeyResultStatus>;
/** Something a human can check in the live town. `met` / `missed` are set only by users with `building.fund`. */
export const KeyResult = z.object({
  id: Id,
  grantId: Id,
  position: z.number().int(),
  text: z.string().min(1).max(300),
  howToCheck: z.string().min(1).max(300),
  status: KeyResultStatus.default("not-started"),
  statusNote: z.string().default(""),
  statusBy: Id.nullable().default(null),
  updatedAt: Iso,
});
export type KeyResult = z.infer<typeof KeyResult>;
/** A grant as the API returns it: its key results (in order) and derived spend. */
export const GrantView = Grant.extend({ keyResults: z.array(KeyResult), spentTokens: z.number().int().nonnegative() });
export type GrantView = z.infer<typeof GrantView>;

// ---------- sessions (a resident's work session) ----------
export const SessionStatus = z.enum(["running", "done", "error", "interrupted"]);
export const Session = z.object({
  id: Id,
  agentId: Id,
  assignmentId: Id.nullable(),
  meetingId: Id.nullable().default(null),
  purpose: z.enum(["work", "review", "facilitate", "summary", "meeting-reply"]),
  /** where the session runs: in-process on the host, or inside the agent's desk container */
  backend: z.enum(["host", "docker"]).default("host"),
  status: SessionStatus,
  model: z.string(),
  sdkSessionId: z.string().nullable().default(null),
  tokens: z.number().int().default(0),
  costUsd: z.number().default(0),
  turns: z.number().int().default(0),
  reportId: Id.nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: Iso,
  endedAt: Iso.nullable().default(null),
  /** how the session was paid for (a desk that fails over from the subscription ends as `api-key`) */
  funding: AllocationAuth.nullish(),
  /** goal-directed budgets: the spend lane, copied from the assignment at start (null = before lanes existed) */
  lane: SpendLane.nullish(),
  /** the grant this session's tokens count against (a grant's spend is the sum over its sessions) */
  grantId: Id.nullish(),
});
export type Session = z.infer<typeof Session>;

/** A human's message for an agent whose session runs outside the server process (queued; the desk polls). */
export const Interrupt = z.object({
  id: Id,
  agentId: Id,
  sessionId: Id.nullable().default(null),
  text: z.string(),
  from: z.string(),
  /** abort the current turn and deliver at once, instead of waiting for the next turn boundary */
  now: z.boolean().default(false),
  createdAt: Iso,
  deliveredAt: Iso.nullable().default(null),
});
export type Interrupt = z.infer<typeof Interrupt>;

// ---------- events (append-only activity log) ----------
export const EventType = z.enum([
  "agent.created", "agent.moved", "agent.status", "agent.activity", "agent.said", "agent.told",
  "agent.tool", "agent.thought", "agent.banned", "agent.retired", "agent.mentioned",
  "doc.created", "doc.updated", "doc.state", "doc.decision",
  "assignment.created", "assignment.status", "assignment.delegated",
  "meeting.created", "meeting.phase", "meeting.utterance", "meeting.decisions",
  "session.started", "session.ended",
  "building.created", "building.updated", "building.layout", "town.plan", "allocation.created", "budget.exhausted", "bank.input", "bank.credited", "bank.share", "bank.pool",
  "grant.created", "grant.updated", "grant.proposed", "grant.countered", "grant.funded", "grant.rejected", "grant.checkpoint", "grant.closed", "kr.updated",
  "skill.used", "skill.pinned", "skill.unpinned",
  "secret.set", "secret.deleted", "secret.granted",
  "export.done", "system",
]);
export const Event = z.object({
  id: z.number().int(),
  ts: Iso,
  type: EventType,
  agentId: Id.nullable().default(null),
  buildingId: Id.nullable().default(null),
  /** short human-readable line, shown in activity feeds and bubbles */
  text: z.string(),
  payload: z.record(z.unknown()).default({}),
});
export type Event = z.infer<typeof Event>;

// ---------- verbs (MCP tools) ----------
/** Inputs for every verb. The MCP server derives tool schemas from these. */
export const VerbInputs = {
  look: z.object({}),
  go: z.object({ to: z.string().describe("A place id (e.g. 'library', 'desk:<agentId>', 'door:<buildingId>', 'meeting-room:<buildingId>') or an agent id to walk to") }),
  say: z.object({ text: z.string().max(2000).describe("Heard by everyone within 3 tiles") }),
  tell: z.object({ to: Id.describe("agent id"), text: z.string().max(4000) }),
  inbox: z.object({ markRead: z.boolean().default(true) }),
  board: z.object({ buildingId: Id.optional().describe("defaults to your building"), limit: z.number().int().positive().max(50).default(20) }),
  search: z.object({ query: z.string(), type: DocType.optional(), state: DocState.optional(), buildingId: Id.optional(), limit: z.number().int().positive().max(50).default(10) }),
  read: z.object({ id: Id, file: z.string().optional().describe("skills: the path of one bundled file to read (from the skill's file list)") }),
  write: z.object({
    id: Id.optional().describe("update an existing doc you authored (a wiki page can also be found by its title; ignored for type 'log')"),
    type: DocType.default("note").describe("'wiki' creates or rewrites your private page on the topic in `title` (your memory: shown to you at the start of every session); 'log' appends `body` as one dated line to your private log"),
    title: z.string(),
    body: z.string(),
    state: z.enum(["draft", "building"]).default("draft").describe("'building' publishes it: type 'fyi' goes on the building's board, anything else is filed in its filing cabinet"),
    provenance: Provenance.optional(),
    tags: z.array(z.string()).optional(),
    files: z.array(SkillFileInput).max(SKILL_LIMITS.files).optional().describe("type 'skill' only: bundled files (scripts, references) stored in the skill's folder; when given, replaces the skill's whole file set"),
  }),
  skills: z.object({ query: z.string().optional().describe("filter by words in the name or description"), limit: z.number().int().positive().max(100).default(30) }),
  pin: PinSkillInput.extend({
    skillId: Id,
    remove: z.boolean().default(false).describe("unpin instead"),
  }),
  submit_report: z.object({
    title: z.string(),
    body: z.string().describe("Markdown with sections: Summary, What I did, Findings, Proposal for next session (or Post-mortem), For others, Questions for humans"),
    verdict: Verdict,
    provenance: Provenance.optional(),
    resumeWhen: WaitFor.optional().describe("Park the work instead of ending it: when this holds (a redeploy with your commit, a colleague's assignment finishing, a decision on a report, a time), your continuation starts by itself. Use when you can't finish because you're waiting on something; at most 3 times in a row, and it's dropped if unmet after 24 h."),
    next: z.string().optional().describe("With resumeWhen: one line saying what you'll do when it resumes (the continuation's title)"),
  }),
  propose_trophy: z.object({ docId: Id, why: z.string() }),
  request_human: z.object({ title: z.string(), body: z.string(), location: z.string().optional(), kind: z.enum(["observation", "data", "contact", "other"]).default("observation") }),
  assignments: z.object({}),
  accept_assignment: z.object({ id: Id }),
  meeting: z.object({
    meetingId: Id,
    action: z.enum(["status", "summary", "speak", "listen", "decide", "end"]),
    text: z.string().optional(),
    decisions: z.array(MeetingDecision).optional(),
    waitSeconds: z.number().int().min(0).max(120).optional().describe("listen only: wait up to this long for someone to speak (default 0 = return now)"),
  }),
  // permissioned
  review: z.object({ docId: Id, decision: ReviewDecision.describe("approve = acknowledge only; continue = next assignment from the report's Proposal; redirect = next assignment from your note (required); stop = stop the agent"), note: z.string().default(""),
    waitFor: WaitFor.optional().describe("continue/redirect: the new assignment waits for this before it starts") }),
  assign: z.object({ agentId: Id, title: z.string(), description: z.string(),
    waitFor: WaitFor.optional().describe("don't start until this holds: {deploy: sha|\"next\"} (live after a redeploy), {assignment: id} (done or cancelled), {decision: reportId}, {after: iso}") }),
  promote: z.object({ docId: Id, state: z.enum(["building", "library"]) }),
  ban: z.object({ agentId: Id, reason: z.string() }),
  redeploy: z.object({ image: z.boolean().default(false).describe("also rebuild the desk image and recreate idle desk containers") }),
} as const;
export type VerbName = keyof typeof VerbInputs;
export const VERB_NAMES = Object.keys(VerbInputs) as VerbName[];

export const VERB_DESCRIPTIONS: Record<VerbName, string> = {
  look: "Where am I, who is nearby (agents and humans, what they're doing), what place this is, and my notices (unread messages, unread mentions of me, pending assignments, upcoming meetings). Visitors: the first look after being offline also carries notices.digest, what arrived while you were away (messages, mentions, assignments offered to you, meetings you missed with their notes doc ids).",
  go: "Walk to a place or to an agent. Returns when you arrive. Walking is free.",
  say: "Say something out loud; heard by everyone within 3 tiles (including humans).",
  tell: "Send a direct message to an agent's inbox.",
  inbox: "Read my messages (direct messages, things I heard, system notices, meeting invites, @mentions of me with the doc or meeting id), newest first.",
  board: "List a building's board: building-wide FYIs (type \"fyi\") that everyone there needs to see. Everything else published in the building (reports, meeting notes, articles, notes) is in its filing cabinet; `search` finds it.",
  search: "Full-text search over documents I can see (library, my building's board, my drafts).",
  read: "Read one document by id. For a skill (type \"skill\") it also lists the skill's bundled files; pass `file` to read one of them.",
  write: "Create or update a document. Drafts are private. State 'building' publishes it: type 'fyi' (a building-wide FYI everyone needs) goes on the board; anything else is filed in the building's filing cabinet.",
  skills: "List the skills I can use: those pinned into my sessions first, then my building's and the library's, with when to use each, their bundled files and how often they're used. `read` a skill to load it.",
  pin: "Pin a skill into sessions: scope agent (just me, `listed` only, unless I'm a manager), building (a manager) or town (an admin). Pins into others' sessions of skills with files, `always` pins for others, and town pins need a human. remove=true unpins.",
  submit_report: "End my work session with a report. Required at the end of every session. The report goes to my manager's in-tray and I go idle until someone gives me a new assignment. If I'm blocked waiting on something (a redeploy, a colleague's assignment, a review decision, a time), pass resumeWhen and next: my work parks and resumes by itself when that holds.",
  propose_trophy: "Propose a library document for the trophy room (collective approval needed).",
  request_human: "Put a request in the town outbox for a human to do something in the real world (observe, fetch data, contact someone). A moderator approves it before humans see it.",
  assignments: "List my assignments.",
  accept_assignment: "Accept a pending assignment; it becomes my current task. Visitors: assignments to you are offers until you accept them (unaccepted offers are cancelled after 24 h); finish with `submit_report`.",
  meeting: "Participate in a meeting: 'summary' submits my short standup summary (did, next), 'speak' adds to the transcript once the discussion has started, 'listen' returns new utterances since my last listen (set waitSeconds to wait for someone to speak), 'decide'/'end' are for the facilitator (to amend a decision, decide again with supersedes = its number in status's decisions list); a decision's waitFor holds its assignment until then, e.g. {deploy: \"next\"} for \"after the redeploy\" or {assignment: id} for \"once X lands\"; while humans are talking, leave 'end' to them.",
  review: "(manager/reviewer) Decide on a pending report in the in-tray: approve (acknowledge), continue (assign its proposal), redirect (assign your note instead), or stop the agent.",
  assign: "(manager/reviewer) Create an assignment for an agent in my building. With waitFor it waits (e.g. for the next redeploy, or another assignment to finish) before it starts.",
  promote: "(manager) Publish a document to the building (board if it's an fyi, else the filing cabinet) or promote it to the library.",
  ban: "(town moderator) Ban an agent town-wide pending review.",
  redeploy: "Pull main on the host, reinstall, rebuild the web client (and the desk image when image=true), then restart the collective's server. Use when Mitchell asks you to deploy or when main has changed and the running town is stale. The restart waits for every running work session, including yours, to end first: never poll or wait for the new build in the same session (that deadlocks until the drain gives up). Call it, say in your report which commit should be live, submit the report, and verify on your next session.",
};

// ---------- verb results (what the LLM sees) ----------
export const NearbyAgent = z.object({ id: Id, name: z.string(), kind: AgentKind, status: AgentStatus, activity: z.string(), distance: z.number() });
export const LookResult = z.object({
  me: z.object({ id: Id, name: z.string(), status: AgentStatus, buildingId: Id.nullable(), place: z.string().nullable(), pos: Tile }),
  building: z.object({ id: Id, name: z.string(), goal: z.string() }).nullable(),
  nearby: z.array(NearbyAgent),
  notices: z.object({ unread: z.number().int(), mentions: z.number().int(), pendingAssignments: z.number().int(), currentAssignment: z.string().nullable(), nextMeeting: z.object({ id: Id, title: z.string(), at: Iso, phase: MeetingPhase }).nullable(),
    /** visitors only, on the first look after coming back from offline */
    digest: z.lazy(() => MailboxDigest).optional() }),
  places: z.array(z.object({ id: Id, name: z.string(), kind: PlaceKind })).describe("places I can `go` to from here"),
});
export type LookResult = z.infer<typeof LookResult>;

/**
 * v1.4: what reached a visitor while it was offline (`look` notices.digest on the "back" transition, and
 * `GET /api/agents/me/digest`). `messages` counts every inbox message received in the window (mentions included);
 * `mentions` the mention subset; `assignmentsOffered` offers created in the window; `meetingsMissed` meetings of its
 * building (or that invited it) that ended in the window.
 */
export const MailboxDigest = z.object({
  offlineSince: Iso,
  messages: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
  assignmentsOffered: z.number().int().nonnegative(),
  meetingsMissed: z.array(z.object({ id: Id, title: z.string(), notesDocId: Id.nullable() })),
});
export type MailboxDigest = z.infer<typeof MailboxDigest>;
/** v1.4: `GET /api/agents/:id` → `mailbox` (visitors): unread inbox messages, unread mentions, open offers. */
export const Mailbox = z.object({ unread: z.number().int().nonnegative(), mentions: z.number().int().nonnegative(), offered: z.number().int().nonnegative() });
export type Mailbox = z.infer<typeof Mailbox>;

/** v1.4: `GET /api/verbs` → one entry per verb (the MCP tool list, over plain HTTP). */
export interface VerbListing { name: VerbName; description: string; inputSchema: Record<string, unknown> }

// ---------- WebSocket protocol ----------
/** A building's token budget, summed over its allocations (derived, not stored). */
export const BuildingBudget = z.object({
  allocatedTokens: z.number().int().nonnegative(),
  spentTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  /** of `remainingTokens`, what the building can still draw from its Bank share */
  bankTokens: z.number().int().nonnegative().default(0),
  /** tokens the building's residents used since the server's local midnight (when daily allowances reset), whatever paid for them */
  tokensToday: z.number().int().nonnegative().default(0),
  /** tokens the building's residents have used, ever */
  tokensAllTime: z.number().int().nonnegative().default(0),
});
export type BuildingBudget = z.infer<typeof BuildingBudget>;

/**
 * A building as the snapshot / WS `building` message carries it: plus `intray`, the count of its pending reports,
 * and `budget` (both derived, not stored; the map badges the manager's desk and labels the sign with them).
 */
export const SnapshotBuilding = Building.extend({ intray: z.number().int().nonnegative().default(0), budget: BuildingBudget.optional() });
export type SnapshotBuilding = z.infer<typeof SnapshotBuilding>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), avatarAgentId: Id.optional(), town: Town, buildings: z.array(SnapshotBuilding), agents: z.array(Agent), places: z.array(Place), grid: z.object({ w: z.number(), h: z.number(), /** row-major tile kinds */ tiles: z.array(z.number()) }), meetings: z.array(Meeting), health: z.object({ docker: z.boolean(), slots: z.object({ running: z.number().int().nonnegative(), max: z.number().int().positive() }).optional() }).optional() }),
  z.object({ type: z.literal("event"), event: Event }),
  z.object({ type: z.literal("agent"), agent: Agent }),
  z.object({ type: z.literal("agents.pos"), positions: z.array(z.object({ id: Id, x: z.number(), y: z.number(), status: AgentStatus })) }),
  z.object({ type: z.literal("doc"), doc: Doc }),
  z.object({ type: z.literal("meeting"), meeting: Meeting }),
  z.object({ type: z.literal("building"), building: Building.extend({ intray: z.number().int().nonnegative().optional(), budget: BuildingBudget.optional() }) }),
  z.object({ type: z.literal("assignment"), assignment: Assignment }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string() }),
  /** the human's avatar moved (client-side movement, server validates walkability) */
  z.object({ type: z.literal("human.move"), x: z.number().int(), y: z.number().int() }),
  z.object({ type: z.literal("human.say"), text: z.string().max(2000) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Tile kinds in the grid (row-major numbers). */
export const TILE = {
  GRASS: 0, PATH: 1, FLOOR: 2, WALL: 3, DESK: 4, SHELF: 5, PLANT: 6, DOOR: 7, TABLE: 8, COUNTER: 9, TROPHY: 10,
  /** a desk with a tray glyph: the manager's desk (in-tray) in each lab */
  MANAGER_DESK: 11,
  /** wall-mounted board (labs: the building board; Town Hall: the schedule board uses SCHEDULE) */
  BOARD: 12,
  /** retired: the Town Hall donation box (donating is at the Bank); the id stays reserved */
  DONATION: 13,
  SCHEDULE: 14,
  /** filing cabinet against the top wall of each lab, two tiles right of the board */
  CABINET: 15,
  /** v1.4: the visitor bench in the Town Hall (furniture; visitors wait on the row above it) */
  BENCH: 16,
  /** the town map on a stand in the Bank (place `bank-map`) */
  BANK_MAP: 17,
  /** the Bank: vault door set in its back wall */
  VAULT: 18,
  /** the Bank: stacked gold bars (decor, not walkable) */
  GOLD: 19,
  /** the Bank: a marble column (decor, not walkable) */
  PILLAR: 20,
} as const;
/**
 * The Bank: a fixed landmark (not a building row, so it never takes a budget share) south of the road,
 * opposite the Town Hall, with its door in the top wall facing the road. Absolute tiles.
 */
export const BANK_LOT = { x: 48, y: 45, w: 17, h: 9 } as const;
/** The Bank's interior, relative to BANK_LOT. Shared so core's layout and the web mock build the same room. */
export const BANK_FIXTURES = {
  door: { x: 8, y: 0 },
  pillars: [{ x: 2, y: 2 }, { x: 14, y: 2 }, { x: 2, y: 5 }, { x: 14, y: 5 }],
  /** the gold teller counter; the `bank` place stands in front of it */
  counter: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }, { x: 11, y: 5 }],
  counterStand: { x: 8, y: 4 },
  /** the town map on its stand (place `bank-map`: E zooms out to the coin flow); stand below it */
  map: { x: 12, y: 2 }, mapStand: { x: 12, y: 3 },
  /** vault door in the back wall, gold bars stacked either side of the walk up to it */
  vault: { x: 8, y: 8 },
  gold: [{ x: 5, y: 7 }, { x: 6, y: 7 }, { x: 10, y: 7 }, { x: 11, y: 7 }],
} as const;
export const WALKABLE = new Set<number>([TILE.GRASS, TILE.PATH, TILE.FLOOR, TILE.DOOR]);

// ---------- REST payloads ----------
export const CreateBuildingInput = Building.pick({ name: true, goal: true, description: true, headcount: true, reviewPolicy: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, rules: true, codeAccess: true, managerAgentId: true }).partial({ goal: true, description: true, headcount: true, reviewPolicy: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, rules: true, codeAccess: true, managerAgentId: true });
/**
 * `poolId` moves the building to another Bank pool at once (admin only; null = General). `explorationTokensPerDay`
 * and `budgetMode` need `building.fund` (a human), so a manager agent can't raise its own allowance.
 */
export const UpdateBuildingInput = CreateBuildingInput.partial().extend({
  poolId: Id.nullable().optional(),
  explorationTokensPerDay: z.number().int().nonnegative().nullable().optional(),
  budgetMode: z.enum(["open", "goal-directed"]).optional(),
});
const KeyResultInput = z.object({ text: z.string().trim().min(1).max(300), howToCheck: z.string().trim().min(1).max(300) });
/** POST /api/buildings/:id/grants: a draft proposal (the manager). */
export const CreateGrantInput = z.object({
  objective: z.string().trim().min(1).max(300),
  stopCondition: z.string().trim().min(1).max(500),
  askTokens: z.number().int().positive(),
  keyResults: z.array(KeyResultInput).min(2).max(3),
  findingsDocIds: z.array(Id).default([]),
});
export type CreateGrantInput = z.input<typeof CreateGrantInput>;
/** PATCH /api/grants/:id while draft / countered. `keyResults` replaces the list (statuses reset). */
export const UpdateGrantInput = CreateGrantInput.partial().extend({ note: z.string().max(2000).optional() });
export type UpdateGrantInput = z.input<typeof UpdateGrantInput>;
/**
 * POST /api/grants/:id/decide (`building.fund`). On a proposed grant: fund (tokens default to the ask), counter
 * (edits + note, back to the manager), reject. On a checkpoint grant: continue, adjust (tokens/KRs/stop condition), cut.
 */
export const DecideGrantInput = z.object({
  action: z.enum(["fund", "counter", "reject", "continue", "adjust", "cut"]),
  tokens: z.number().int().positive().optional(),
  keyResults: z.array(KeyResultInput).min(2).max(3).optional(),
  stopCondition: z.string().trim().min(1).max(500).optional(),
  note: z.string().max(2000).default(""),
});
export type DecideGrantInput = z.input<typeof DecideGrantInput>;
/** POST /api/grants/:id/close: the manager may close as `stopped`; `building.fund` any outcome. */
export const CloseGrantInput = z.object({ outcome: GrantOutcome, note: z.string().max(2000).default("") });
export type CloseGrantInput = z.input<typeof CloseGrantInput>;
/** PATCH /api/key-results/:id: the manager up to `claimed`; `building.fund` for `met` / `missed`. */
export const UpdateKeyResultInput = z.object({ status: KeyResultStatus, note: z.string().max(2000).default("") });
export type UpdateKeyResultInput = z.input<typeof UpdateKeyResultInput>;
/** GET /api/buildings/:id/grants?status= */
export const GrantsQuery = z.object({ status: GrantStatus.optional() });
/** PUT /api/buildings/:id/layout: lot-relative anchors for moved pieces (left out = stays put); `dryRun` only checks it. */
export const LayoutInput = z.object({ furniture: z.record(Tile), dryRun: z.boolean().default(false) });
/**
 * PUT /api/town/plan (town planning): new lots per building (left out = stays put), optionally one new building
 * drawn on the map; `dryRun` only checks it.
 */
export const PlanInput = z.object({ lots: z.record(Lot).default({}), create: CreateBuildingInput.extend({ lot: Lot }).optional(), dryRun: z.boolean().default(false) });
/** POST /api/agents/residents: `name` left out or blank = the town picks an unused one (GET /api/agents/name-suggestion previews one). */
export const CreateResidentInput = z.object({ buildingId: Id, name: z.string().trim().optional(), title: z.string().default(""), direction: z.string().default(""), sprite: z.number().int().optional(), model: z.string().optional() });
export const RegisterVisitorInput = z.object({ name: z.string(), buildingId: Id.optional(), title: z.string().optional(),
  /** default true: the visitor acts with its owner's permissions (capped by them) */
  inheritsOwner: z.boolean().optional() });
export const AgentPermissionsPatch = z.object({ inheritsOwner: z.boolean().optional(), deniedPermissions: z.array(Permission).optional() });
export type AgentPermissionsPatch = z.infer<typeof AgentPermissionsPatch>;
/** PATCH /api/agents/:id/model: the model for its work sessions; null = its home building's model. */
export const AgentModelPatch = z.object({ model: z.string().trim().min(1).nullable() });
export const ReviewInput = z.object({ decision: ReviewDecision, note: z.string().default(""), waitFor: WaitFor.optional() });
export const ChatInput = z.object({ message: z.string(), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]) });
/** POST /api/docs/:id/reply: the reply text (empty = archive). */
export const ReplyInput = z.object({ text: z.string().default("") });
/** POST /api/docs/:id/ask: a question about a report, answered by a cheap-model proxy (not the author). */
export const AskInput = z.object({ question: z.string().min(1), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]) });
export const InterruptInput = z.object({ text: z.string(), now: z.boolean().optional() });
/** POST /api/agents/:id/message: a human messages an agent (a `tell` from their avatar). `now` (default true) interrupts a working agent; false leaves it in the inbox. */
export const MessageAgentInput = z.object({ text: z.string().trim().min(1), now: z.boolean().default(true) });
export const WorkInput = z.object({ title: z.string().optional(), description: z.string().optional(), waitFor: WaitFor.optional() });
/**
 * POST /api/donate. `auth` defaults to donor-key when the donor gives (or has stored) their own key, else api-key.
 * `subscription` and `api-key` spend the town's own credentials, so they need admin or town.allocate_budget.
 */
export const DonateInput = z.object({ tokens: z.number().int().positive(), buildingId: Id, apiKey: z.string().optional(), auth: AllocationAuth.optional(), label: z.string().max(200).optional() });
/** POST /api/bank/inputs. `apiKey` is required for source `api-key`; a subscription is daily and needs `weeklyCapTokens`. */
export const AddBankInput = z.object({
  label: z.string().min(1),
  source: BankSource,
  model: z.string().min(1),
  tokens: z.number().int().positive(),
  recurrence: BankRecurrence.default("once"),
  weeklyCapTokens: z.number().int().positive().optional(),
  /** first renewal for a recurring input (default: now) */
  nextCreditAt: Iso.optional(),
  apiKey: z.string().min(1).optional(),
});
export type AddBankInput = z.input<typeof AddBankInput>;
/** POST /api/bank/pools (admin). `pct` null or left out: the pool splits what's left equally with the others. */
export const CreateBankPoolInput = z.object({ name: z.string().trim().min(1).max(80), pct: z.number().min(0).max(100).nullable().default(null) });
export type CreateBankPoolInput = z.input<typeof CreateBankPoolInput>;
/** PATCH /api/bank/pools/:id (admin). */
export const UpdateBankPoolInput = z.object({ name: z.string().trim().min(1).max(80).optional(), pct: z.number().min(0).max(100).nullable().optional() });
export type UpdateBankPoolInput = z.input<typeof UpdateBankPoolInput>;
export const CreateMeetingInput = z.object({ kind: MeetingKind, buildingId: Id.nullable(), title: z.string().optional(), scheduledAt: Iso.optional(), agenda: z.string().optional(), startNow: z.boolean().default(false),
  /** who to invite; omitted = the building's residents (town hall: managers, reviewers, moderators) */
  attendeeIds: z.array(Id).min(1).optional() });
export const MeetingSayInput = z.object({ text: z.string() });
export const SeedInput = z.object({ importDir: z.string().optional() });
/** POST /api/admin/redeploy (permission `town.redeploy`); also the `redeploy` verb's input */
export const RedeployInput = z.object({ image: z.boolean().default(false) });
/**
 * `{ started: true }` (runs in the background, progress as `system` events) or `{ queued: true }` when one is in flight:
 * the request joins it (its post-drain pull takes the latest main; past that pull, it runs again after the restart).
 * `running` is the pre-join answer, kept for old clients.
 */
export const RedeployResult = z.object({
  started: z.boolean().optional(), queued: z.boolean().optional(), running: z.boolean().optional(),
  /** for an agent in a work session: the restart only happens after its session ends, so it must not wait for it */
  note: z.string().optional(),
});
export type RedeployResult = z.infer<typeof RedeployResult>;
/**
 * Where a redeploy is, carried as `payload.run` on every redeploy `system` event so a client reads the latest one:
 * `running` (pull/build), `scheduled` (built; draining, waiting for `working` sessions to end while `blocked` agents'
 * work is held), `restarting`, `done` (emitted by the restarted server), `failed`, `aborted` (the server was restarted
 * mid-run; emitted at startup). `commits` = changes pulled. A run's last event carries `payload.terminal: true`.
 */
export interface RedeployRun {
  state: "running" | "scheduled" | "restarting" | "done" | "failed" | "aborted";
  requestedBy: string;
  commits: number | null;
  /** agent ids with a live work session the drain waits for */
  working: string[];
  /** agent ids with pending work the drain is holding */
  blocked: string[];
  /** the commit being restarted into (`restarting`) or now live (`done`) */
  head?: string;
}

/** `GET /api/admin/redeploy`: the runtime's live view of a redeploy (the HUD checks the event-derived banner against it). */
export const RedeployLive = z.object({
  running: z.boolean(),
  /** the step in progress ("git pull --rebase origin main", "build web", "drain", "restarting"…), "idle" when none */
  phase: z.string(),
  /** names of the agents the drain is waiting for */
  waitingFor: z.array(z.string()),
  /** when the current phase started (ISO), null when idle */
  since: z.string().nullable(),
});
export type RedeployLive = z.infer<typeof RedeployLive>;
/** Work-session slots on the host: `running` live or starting sessions out of `max` (desks.maxRunning). */
export const SessionSlots = z.object({ running: z.number().int().nonnegative(), max: z.number().int().positive() });
export type SessionSlots = z.infer<typeof SessionSlots>;
/**
 * `health` on the snapshot: `docker` = the runtime's last docker probe (true when docker isn't used or not probed);
 * `slots` = work-session slots (absent without a runtime).
 */
export const TownHealth = z.object({ docker: z.boolean(), slots: SessionSlots.optional() });
export type TownHealth = z.infer<typeof TownHealth>;

export const AuthMe = z.object({ user: User, roles: z.array(Role), avatarAgentId: Id.nullable(), isAdmin: z.boolean() });
export type AuthMe = z.infer<typeof AuthMe>;
/** `GET /api/auth/config`: what sign-in the server offers (`githubClientId` null = GitHub login not configured). */
export const AuthConfig = z.object({ githubClientId: z.string().nullable(), publicUrl: z.string() });
export type AuthConfig = z.infer<typeof AuthConfig>;
/** `POST /api/auth/github/device`: a GitHub access token from the device flow (verified, never stored). */
export const GithubDeviceInput = z.object({ accessToken: z.string().min(1) });

// ---------- collective (one instance of the town: config + data dir + seed buildings) ----------
export const CollectiveBuildingSpec = z.object({
  /** fixed id (default: slug of name) */
  id: Id.optional(),
  /** import a v0 building folder instead of creating from fields (path relative to the collective dir) */
  import: z.string().optional(),
  name: z.string().optional(),
  goal: z.string().optional(),
  description: z.string().optional(),
  headcount: z.number().int().positive().optional(),
  reviewPolicy: ReviewPolicy.optional(),
  model: z.string().optional(),
  cheapModel: z.string().optional(),
  maxTurnsPerSession: z.number().int().positive().optional(),
  dailyTokensPerAgent: z.number().int().positive().optional(),
  meetings: z.array(MeetingCadence).optional(),
  /** residents get code tools on the collective's repo (collective.json `workspace`) */
  codeAccess: z.boolean().optional(),
  residents: z.array(z.object({
    name: z.string(), title: z.string().default(""), direction: z.string().default(""), sprite: z.number().int().optional(), model: z.string().optional(),
    /** town role names granted at seed (e.g. `deployer`) */
    townRoles: z.array(z.string()).optional(),
  })).default([]),
  /** the building's reviewer agent (role `reviewer`); works the in-tray when reviewPolicy is `reviewer` */
  reviewer: z.object({ name: z.string(), sprite: z.number().int().optional(), direction: z.string().optional() }).optional(),
  /** house allocation for this building, in tokens */
  houseTokens: z.number().int().nonnegative().optional(),
});
/** How resident work sessions run: in a desk container (docker), in-process (host), or docker when available (auto). */
export const DesksConfig = z.object({
  backend: z.enum(["docker", "host", "auto", "fly"]).default("auto"),
  image: z.string().default("muster-town-desk"),
  /** the desk image for `fly` (default registry.fly.io/$FLY_APP:desk, built from fly.desk.toml) */
  snapshot: z.string().default("muster-town-desk"),
  /** `fly` only: where desk Machines run, and their size (defaults iad, shared 2 vCPU, 2048 MB) */
  region: z.string().optional(),
  cpuKind: z.enum(["shared", "performance"]).optional(),
  cpus: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  /** sandbox backends (`fly`) only: the town's public base URL desks call back to (e.g. https://muster.town); docker desks use host.docker.internal */
  townUrl: z.string().url().optional(),
  /** where desks get GH_TOKEN: `gh auth token` on the host, the host's GH_TOKEN env, or none */
  ghToken: z.enum(["gh-cli", "env", "none"]).default("gh-cli"),
  /**
   * How many work sessions may run at once on this host (a running session costs ~0.2 GB, peaking ~0.7 GB while it
   * compiles). Queued work waits for a free slot; the scheduler never starts more. Changeable live (PUT /api/town/desks).
   */
  maxRunning: z.number().int().positive().default(20),
});
export type DesksConfig = z.infer<typeof DesksConfig>;
/** `PUT /api/town/desks` (admin): the host settings that can change while the server runs. */
export const DesksPatch = z.object({ maxRunning: z.number().int().positive().max(1000) });
export type DesksPatch = z.infer<typeof DesksPatch>;

export const CollectiveConfig = Town.extend({
  /** the collective's repo (path relative to the collective dir); buildings opt in with `codeAccess` */
  workspace: Workspace.optional(),
  port: z.number().int().positive().optional(),
  desks: DesksConfig.optional(),
  /** town moderators: Town Hall residents holding the town `moderator` role, seated at the mod station */
  moderators: z.array(z.object({ name: z.string(), sprite: z.number().int().optional(), direction: z.string().optional() })).default([]),
  buildings: z.array(CollectiveBuildingSpec).default([]),
});
export type CollectiveConfig = z.infer<typeof CollectiveConfig>;
export type CollectiveBuildingSpec = z.infer<typeof CollectiveBuildingSpec>;

// ---------- desks: agent-scoped API (bearer agent token; the desk process inside the container calls these) ----------
export const DeskWorkspace = z.object({
  repoUrl: z.string(),
  base: z.string(),
  branch: z.string(),
  branchPrefix: z.string(),
  /** checkout dir inside the desk, /home/agent/work/<repoName> */
  dir: z.string(),
});
export type DeskWorkspace = z.infer<typeof DeskWorkspace>;

/** GET /api/agents/me/brief?session= */
export const DeskBrief = z.object({
  agent: Agent,
  building: Building,
  town: Town,
  assignment: Assignment.nullable(),
  session: Session,
  /** appended to the claude_code system prompt preset */
  system: z.string(),
  /** first user message */
  prompt: z.string(),
  workspace: DeskWorkspace.optional(),
});
export type DeskBrief = z.infer<typeof DeskBrief>;

/** POST /api/agents/me/activity → 204 */
export const DeskActivityInput = z.object({
  session: Id,
  kind: z.enum(["tool", "thought", "status"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  text: z.string().optional(),
});
export type DeskActivityInput = z.infer<typeof DeskActivityInput>;

/** GET /api/agents/me/control?session= */
export const DeskControl = z.object({
  interrupts: z.array(z.object({ id: Id, text: z.string(), from: z.string() })),
  stop: z.boolean(),
});
export type DeskControl = z.infer<typeof DeskControl>;

/** POST /api/agents/me/control/ack → 204 */
export const DeskControlAckInput = z.object({ ids: z.array(Id) });
export type DeskControlAckInput = z.infer<typeof DeskControlAckInput>;

/** POST /api/agents/me/session-end → { session } */
export const DeskSessionEndInput = z.object({
  session: Id,
  tokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(0),
  sdkSessionId: z.string().nullable().optional(),
  finalText: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  reportSubmitted: z.boolean().default(false),
  /** what actually paid: `api-key` with `fallback` when the desk failed over from the subscription */
  fundingUsed: AllocationAuth.optional(),
  /** the desk hit the subscription's spend limit and reran the session on the fallback API key */
  fallback: z.boolean().optional(),
});
export type DeskSessionEndInput = z.infer<typeof DeskSessionEndInput>;

export { toJsonSchema } from "./json-schema.ts";
export { townEnv, townEnvBoth, ENV_PREFIX, OLD_ENV_PREFIX, type TownEnvName } from "./env.ts";
