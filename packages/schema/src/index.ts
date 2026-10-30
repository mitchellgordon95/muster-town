/**
 * @muster-town/schema — the single source of truth for world state, documents,
 * events, verbs, and API payloads. Server, runtime, web client, CLI and MCP
 * tools all import from here. If it isn't in this file, it isn't in the contract.
 */
import { z } from "zod";
import { TOKEN_COUNTS_SHAPE, TokenCounts } from "./tokens.ts";

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

/** One entry of the collectives homepage (`GET /api/collectives`): the Workshop, the hub's hosted collectives, or the placeholder. */
export const Collective = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** shown under the name: a collective's goal is its tagline */
  goal: z.string().default(""),
  /** where its town opens (e.g. `/workshop/`); empty for a placeholder */
  url: z.string().default(""),
  /** not open yet: listed as "coming soon", with no Open link */
  placeholder: z.boolean().optional(),
});
export type Collective = z.infer<typeof Collective>;

/**
 * One self-hosted town listed by muster.town's directory (`GET /api/directory` → `{towns: DirectoryTown[]}`, design dc_d6chojzl2a):
 * a host that proved control and answered within the last 24 h. name and goal come from its own `/api/collectives`.
 */
export const DirectoryTown = z.object({
  host: z.string(),
  /** always `https://<host>/` */
  url: z.string(),
  name: z.string(),
  goal: z.string(),
  verifiedAt: z.string(),
  lastSeenAt: z.string(),
});
export type DirectoryTown = z.infer<typeof DirectoryTown>;
/** `GET /api/directory` (muster.town only). */
export const DirectoryList = z.object({ towns: z.array(DirectoryTown) });
export type DirectoryList = z.infer<typeof DirectoryList>;

/** Path segments a hosted collective can't take: the Workshop's own routes and the homepage's (docs/hosted-collectives.md). */
export const RESERVED_SLUGS: readonly string[] = ["workshop", "api", "auth", "ws", "mcp", "media", "next", "skill.md", "hosted", "assets", "home"];
/** A hosted collective's address segment: lowercase letters, digits and dashes, 2 to 40, no dash at either end. */
export const COLLECTIVE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
/** The address a name gets (`Garden Club!` → `garden-club`): what the Start form shows and `POST /api/collectives` uses. */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}
/** Why a slug can't be used (null: it can, unless taken). */
export function slugProblem(slug: string): string | null {
  if (!COLLECTIVE_SLUG.test(slug)) return "The address needs 2 to 40 letters or digits (dashes between them).";
  if (RESERVED_SLUGS.includes(slug)) return `muster.town/${slug} is reserved: pick another name.`;
  return null;
}
/**
 * Why a hosted collective's key is refused (null: fine, or empty). An Anthropic Console API key only: Anthropic does
 * not let a third party collect or store Claude.ai credentials, so subscription tokens (`sk-ant-oat…`) are refused.
 */
export function apiKeyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.startsWith("sk-ant-oat")) return "That is a Claude subscription token: Anthropic does not let a third party store those. Paste an API key from the Claude Console (sk-ant-api…), or host your own Muster Town from the open-source repository to run on your subscription.";
  if (!/^sk-ant-api\S{8,}$/.test(k)) return "An Anthropic API key starts with sk-ant-api (create one in the Claude Console).";
  return null;
}

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
  "town.approve_request",    // delete an outbox request (misuse); requests need no approval to be visible
  "town.ban",                // ban an agent (town-wide; misuse prevention)
  "town.moderate",           // moderator station: outbox requests, bans
  "town.redeploy",           // pull main on the host, rebuild, restart the collective's server
  "building.manage",         // edit goal/description/policies, assign building roles
  "building.assign",         // create assignments for agents in the building
  "building.review",         // acknowledge/continue/redirect/stop reports (the in-tray)
  "building.dismiss",        // dismiss (retire) a resident of the building
  "building.promote",        // promote a doc from building -> library
  "building.fund",           // fund / counter / reject grant proposals, decide checkpoints, mark key results met/missed (never effective for agents)
  "doc.write_building",      // publish own docs to the building board
  "doc.request_human",
  "meeting.facilitate",
  "meeting.attend",
  "town.interact",           // act in the town at all (move, talk, message, write): members; signed-in visitors only read
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
    moderator: ["town.approve_request", "town.ban", "town.moderate", "town.interact"] as Permission[],
    /** signed in, read-only until an admin lets them in (`member`) */
    visitor: ["meeting.attend"] as Permission[],
    /** may redeploy the running town from main (workshop residents; building managers and their forks hold town.redeploy without it outside a hosted collective) */
    deployer: ["town.redeploy", "town.interact"] as Permission[],
    /** let in by an admin (an access request granted): may move, talk, message agents and write */
    member: ["town.interact", "meeting.attend", "doc.request_human"] as Permission[],
  },
  building: {
    manager: [
      "building.manage", "building.assign", "building.review", "building.promote", "building.dismiss", "building.fund",
      "doc.write_building", "doc.request_human", "meeting.facilitate", "meeting.attend",
    ] as Permission[],
    /** a second pair of eyes on reports (may decide in the in-tray and facilitate); no longer drives review by itself */
    reviewer: ["building.review", "building.assign", "meeting.facilitate", "meeting.attend", "doc.write_building"] as Permission[],
    member: ["doc.write_building", "doc.request_human", "meeting.attend"] as Permission[],
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
// Who works a building's in-tray is not a setting (town hall 2026-10-24, decision 1a): if the building has a manager
// agent (`managerAgentId`, not stopped/banned/retired) the manager works it, else the humans holding `building.review` do.
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
  /** model for resident work sessions; cheapModel for summaries/proxy chat */
  model: z.string().default("claude-opus-5-5"),
  cheapModel: z.string().default("claude-haiku-5-5"),
  /** safety rail per work session, not a design parameter */
  maxTurnsPerSession: z.number().int().positive().default(80),
  /** tokens each resident may spend per day */
  dailyTokensPerAgent: z.number().int().positive().default(350_000),
  meetings: z.array(MeetingCadence).default([]),
  /** standing rules (markdown) from the building's manager; every session in this building starts with them */
  rules: z.string().max(8000).default(""),
  /** the resident a human set as this building's manager: it works the in-tray (its residents' reports), facilitates meetings and wears a manager badge; null = none set, humans work the in-tray */
  managerAgentId: Id.nullable().default(null),
  /** residents get code tools on the collective's repo (`Town.workspace`) during work sessions */
  codeAccess: z.boolean().default(false),
  /** the Bank pool this building draws from; null = the collective's default pool, General (`DEFAULT_POOL_ID`) */
  poolId: Id.nullable().default(null),
  /** goal-directed budgets: tokens per day for exploration work; null = 10% of its pool's daily inflow */
  explorationTokensPerDay: z.number().int().nonnegative().nullable().default(null),
  /** Unused: nothing reads it since the `open` mode was removed (every lab is lane-gated, the Town Hall never is; core/src/lanes.ts `laneGated`). Kept with `open` in the enum because migration 025 wrote `open` on old rows; dropping the column is a later migration. */
  budgetMode: z.enum(["open", "goal-directed"]).default("goal-directed"),
  /** goal-directed: since when the building is blocked (its goal has no key results and it has no funded grant); null = not blocked. The manager is woken once per blocked transition. */
  blockedAt: Iso.nullable().default(null),
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
  /** what it has paid for, by kind (Bank grant step 1); `spentRawTokens` is their sum, derived by the database; `spentTokens` is the booked adjusted output tokens (step 3) */
  spentInput: z.number().int().nonnegative().default(0),
  spentOutput: z.number().int().nonnegative().default(0),
  spentCacheRead: z.number().int().nonnegative().default(0),
  spentCacheWrite5m: z.number().int().nonnegative().default(0),
  spentCacheWrite1h: z.number().int().nonnegative().default(0),
  spentRawTokens: z.number().int().nonnegative().default(0),
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
export const BankCredit = z.object({ id: Id, inputId: Id, ...TOKEN_COUNTS_SHAPE, rawTokens: z.number().int().nonnegative().default(0), tokens: z.number().int().nonnegative().default(0), createdAt: Iso, expiresAt: Iso.nullable().default(null) });
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
 * `inputId` / `grantId`: set when a grant's own input paid (member funding: the grant's `fundedWith`), not for pool draws.
 */
export const BankDebit = z.object({ id: Id, buildingId: Id, poolId: Id, agentId: Id, creditId: Id.nullable().default(null), inputId: Id.nullable().default(null), grantId: Id.nullable().default(null), ...TOKEN_COUNTS_SHAPE, rawTokens: z.number().int().nonnegative().default(0), tokens: z.number().int().nonnegative().default(0), createdAt: Iso });
export type BankDebit = z.infer<typeof BankDebit>;
/** One charge of model usage: who spent it and which building it counts for (the agent's home). The usage ledger behind tokensToday / tokensAllTime. */
export const UsageEntry = z.object({ id: Id, agentId: Id, buildingId: Id.nullable().default(null), ...TOKEN_COUNTS_SHAPE, rawTokens: z.number().int().nonnegative().default(0), tokens: z.number().int().nonnegative().default(0), usd: z.number().nonnegative().default(0), createdAt: Iso });
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
  /** manager forks (dc_mymt27yz25): the manager this row is a short-lived fork of ("Pix 3"); null = a named agent */
  forkOf: Id.nullable().default(null),
  /** a fork's number n in "<Manager> <n>": the lowest not used by a live fork of that manager */
  forkN: z.number().int().positive().nullable().default(null),
  /** a family root (an agent that isn't a fork): today's adjusted tokens of its own sessions plus its forks'; forks are capped by it (dailyTokensPerAgent × headcount) */
  familySpentToday: z.number().int().nonnegative().default(0),
});
export type Agent = z.infer<typeof Agent>;

// ---------- places (named points on the map) ----------
export const PlaceKind = z.enum([
  "desk", "door", "library", "outbox", "meeting-room", "plaza",
  /** board:<buildingId> — wall board inside each lab */
  "board",
  /** cabinet:<buildingId> — filing cabinet beside the board: the building's reports and meeting notes */
  "cabinet",
  /** intray:<buildingId> — the manager's desk (pending reports) */
  "intray",
  /** mod-station — Town Hall desk where town moderators sit */
  "mod-station",
  /** planning-desk — Town Hall: buildings, residents, roles, secrets, system */
  "planning",
  /** town-map — Town Hall: the big map table; using it opens town planning (move, resize and draw buildings) */
  "town-map",
  /** retired: the Town Hall donation box (donating is at the Bank); no layout emits it any more */
  "donation",
  /** schedule-board — Town Hall: upcoming meetings for every building; schedule:<buildingId> — each lab's schedule board (its timed jobs) */
  "schedule",
  /** visitor-bench — Town Hall, beside the door: where visitors without a building desk wait */
  "bench",
  /** bank-map — the Bank: a town map; using it zooms out to the whole town and shows the Bank's tokens flowing to each building by share */
  "bank-map",
  /** bank — the Bank's vault (`bank`) and stations (`bank:<slug>`, BANK_FIXTURES.stations): each opens one tab of the Bank panel */
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
  "flag",          // a human's quick request planted in a building: pending in its in-tray until the manager delegates it (docs/waterfall.md §3.1)
  "assignment-proposal", // reserved
  "notebook",      // retired (migration 028 turned notebooks into wiki pages); kept so old events and exports still parse
  "wiki",          // an agent's memory: one private page per topic it knows (title = topic), rewritten before each report, injected into its sessions
  "log",           // an agent's memory: one private append-only log of durable events (assignments, reports, decisions); its tail is injected
  "skill",         // a reusable skill: SKILL.md (frontmatter name + description, then instructions) plus bundled files (docs/skills.md)
  "deck",          // slides: markdown split on lines `---`, the first slide's `#` heading is the title, an optional last line `Notes: …` per slide is presenter-only (deck.ts)
]);
export type DocType = z.infer<typeof DocType>;

/** The only types pinned to a building's board (building-wide FYIs). Every other published doc is filed in its filing cabinet. */
export const BOARD_TYPES: readonly DocType[] = ["fyi"];

export const DocState = z.enum(["draft", "building", "library"]);
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
/**
 * Outbox request lifecycle: open (visible to every human at once, no approval step) → claimed → done.
 * "rejected" is legacy (the old moderator gate); "proposed"/"approved" from before migration 045 read as open.
 */
export const RequestStatus = z.preprocess((v) => (v === "proposed" || v === "approved" ? "open" : v), z.enum(["open", "claimed", "done", "rejected"]));

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
  // flag-specific: the tile it stands on, until the building's manager walks to it and picks it up (`go flag:<id>`)
  flagPos: Tile.optional(),
  pickedUpAt: Iso.optional(),
  pickedUpBy: Id.optional(),
  /** wiki only: a building-owned topic page of this building (published there; its manager and the manager's forks rewrite it, every rewrite revisioned) */
  topicOf: Id.optional(),
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
/**
 * Wakes step 1 (docs/wakes.md): the human a chain of work traces to. The town stamps it when a human acts (a tell, an
 * assign, a flag, a 1:1, a decision on a report); a session inherits it from its assignment or its meeting; `tell`,
 * `assign` and @mentions copy the acting session's origin with `hops + 1`. Never a verb input, so agents can't forge it.
 */
export const Origin = z.object({
  /** the human user */
  userId: Id,
  /** what the human did it through: a message, meeting, doc or assignment id (null = no record of its own) */
  via: z.string().nullable(),
  /** relays since the human acted (0 = the human's own act) */
  hops: z.number().int().nonnegative(),
  /** when the human acted */
  at: Iso,
});
export type Origin = z.infer<typeof Origin>;
export const AssignmentStatus = z.enum(["pending", "active", "done", "cancelled"]);
/** Manager forks: whose queue an assignment is on (`building` = run by a fork of the building's manager). */
export const AssignmentQueue = z.enum(["agent", "building"]);
export type AssignmentQueue = z.infer<typeof AssignmentQueue>;
/** Every session runs in one lane: work on a funded grant, goal-scoped exploration, or work a human asked for directly. */
export const SpendLane = z.enum(["grant", "exploration", "directed"]);
export type SpendLane = z.infer<typeof SpendLane>;
/**
 * The lane fields of `assign` and POST /api/agents/:id/work (docs/goal-directed-budgets.md). Left out: the lane of the
 * work it continues, else directed. exploration needs keyResultId (a goal key result with no funded grant) or gap; grant
 * needs grantId (its key result is implied).
 */
export const LaneFields = z.object({
  lane: SpendLane.optional().describe("grant (work on a funded grant's key result), exploration (names a key result or a goal gap), directed (a human asked for it; an agent in a goal-directed building gives its human source in sourceId)"),
  grantId: Id.optional().describe("lane grant: the grant"),
  keyResultId: Id.optional().describe("lane exploration: a key result of the building goal that has no funded grant (lane grant: implied by the grant; lane directed: optional, the work stops once a grant proposal names it)"),
  gap: z.string().trim().max(300).optional().describe("lane exploration without a key result: one sentence on what is missing between the goal and the live town (lane directed: optional, what the human asked about)"),
  sourceId: Id.optional().describe("lane directed: the human-authored source it traces to: a meeting with a human (mt_…) or its notes, a flag, a human-report, a rollup a human replied to, or a human's tell (ms_…)"),
});
export type LaneFields = z.infer<typeof LaneFields>;
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
  /** goal-directed budgets: the spend lane (directed = a human asked for it; agents can't create it in goal-directed buildings) */
  lane: SpendLane.default("directed"),
  /** lane grant: the funded grant it draws on */
  grantId: Id.nullable().default(null),
  /** the goal key result it works toward: lane grant = its grant's (null on the manager's checkpoint assignment); exploration = the one it names */
  keyResultId: Id.nullable().default(null),
  /** lane exploration without a key result: the goal gap it investigates (one sentence) */
  gap: z.string().max(300).nullable().default(null),
  /** lane directed: the human-authored source it traces to (meeting, doc or tell id); null for work a human created directly */
  sourceId: Id.nullable().default(null),
  /** why the scheduler isn't starting it although it is next ("held: grant at checkpoint"); null = not held. Never cancelled for it. */
  heldReason: z.string().nullable().default(null),
  /** wakes: the human this work traces to (null = none) */
  origin: Origin.nullable().default(null),
  /** manager forks: the first assignment of its chain (retries, park continuations and review follow-ups inherit it); its own id on a fresh chain */
  chainId: Id.nullable().default(null),
  /** manager forks: `agent` = runs for agentId as always; `building` = queued to the building (agentId holds the manager until a fork takes it, then the fork) */
  queue: AssignmentQueue.default("agent"),
  /** building-queue work: the model its fork runs on (one the building allows: model or cheapModel); null = the building's model */
  model: z.string().nullable().default(null),
  /** manager forks: topic pages (doc ids, at most 3) the manager attached for its fork's memory block */
  pages: z.array(Id).max(3).optional(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Assignment = z.infer<typeof Assignment>;
/**
 * Why a queued assignment can't start now (GET /api/agents/:id on pending assignments, GET /api/blocked): `kind` and the
 * thing it waits on (`targetId`: an assignment, a commit sha, a report, a grant, a building), the reason in words, and
 * where the map's red line goes: the blocking colleague's body (`agentId`) or a place (`placeId`: the in-tray that holds
 * the decision, the Town Hall in-tray for a grant or allowance hold, the building's door for a deploy). Neither = no line.
 */
export const BlockedKind = z.enum(["assignment", "deploy", "decision", "grant", "exploration", "reserved", "budget"]);
export type BlockedKind = z.infer<typeof BlockedKind>;
export const BlockedBy = z.object({
  kind: BlockedKind,
  targetId: z.string().nullable(),
  text: z.string(),
  agentId: z.string().optional(),
  placeId: z.string().optional(),
});
export type BlockedBy = z.infer<typeof BlockedBy>;
/** One blocked queued assignment of an agent (GET /api/blocked). */
export interface BlockedAssignment { assignmentId: string; title: string; blockedBy: BlockedBy }
/**
 * A building's schedule (Mitchell, 1:1 mt_w7z9k1z112; docs/scheduling.md): a timed job lives on its building, not on an
 * agent. When `nextRunAt` comes it creates one normal assignment on the building queue (a fork of the manager runs it);
 * a building with no manager agent has nobody to take it. No repeat = one-shot; `everyMinutes` or `dailyAt` ("HH:MM" UTC)
 * repeat it until `endsAt`. GET /api/scheduled lists the active ones, soonest first.
 */
export const ScheduleStatus = z.enum(["active", "ended"]);
export const Schedule = z.object({
  id: Id,
  buildingId: Id,
  title: z.string(),
  description: z.string(),
  /** the next (or only) run; null once ended */
  nextRunAt: Iso.nullable().default(null),
  /** repeat every N minutes (>= 60); null = not an interval */
  everyMinutes: z.number().int().nullable().default(null),
  /** repeat at these UTC times of day ("HH:MM"); null = not daily */
  dailyAt: z.array(z.string()).nullable().default(null),
  /** a repeating schedule ends here (null on a one-shot) */
  endsAt: Iso.nullable().default(null),
  /** a repeat also ends once it has fired this many times (null = only endsAt) */
  maxRuns: z.number().int().positive().nullable().default(null),
  /** paused: keeps its next run but does not fire until resumed */
  paused: z.boolean().default(false),
  lane: SpendLane.nullable().default(null),
  grantId: Id.nullable().default(null),
  keyResultId: Id.nullable().default(null),
  gap: z.string().nullable().default(null),
  sourceId: Id.nullable().default(null),
  pages: z.array(Id).max(3).default([]),
  model: z.string().nullable().default(null),
  origin: Origin.nullable().default(null),
  status: ScheduleStatus.default("active"),
  /** why it ended: "ran" (one-shot), "ended" (past endsAt), "cancelled by …", or the lane problem */
  endedReason: z.string().nullable().default(null),
  lastRunAt: Iso.nullable().default(null),
  /** the assignment its last fire created */
  lastAssignmentId: Id.nullable().default(null),
  runs: z.number().int().default(0),
  createdBy: Id,
  createdByKind: z.enum(["agent", "user"]),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Schedule = z.infer<typeof Schedule>;
/** The repeat of a schedule (`assign … repeat`, POST /api/buildings/:id/schedules): every N hours or at UTC times of day, until a date. */
export const ScheduleRepeat = z.object({
  everyHours: z.number().positive().max(24 * 7).optional().describe("repeat every N hours (at least 1)"),
  dailyAt: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM (UTC)")).min(1).max(24).optional().describe("repeat every day at these UTC times, e.g. [\"20:00\"]"),
  until: Iso.optional().describe("last day it may run (default 14 days out, at most 90)"),
  times: z.number().int().min(1).max(1000).optional().describe("or end after this many runs (skipped runs don't count)"),
}).strict();
export type ScheduleRepeat = z.infer<typeof ScheduleRepeat>;
/** POST /api/buildings/:id/schedules: what `assign` takes, plus when. `runsAt` left out = the repeat's first occurrence. */
export const CreateScheduleInput = LaneFields.extend({
  title: z.string().min(1), description: z.string().default(""),
  runsAt: Iso.optional(), repeat: ScheduleRepeat.optional(),
  pages: z.array(Id).max(3).optional(), model: z.string().optional(),
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleInput>;
/** Edit a schedule (`schedule scheduleId`, POST /api/schedules/:id): what changes; a new repeat replaces the old one. */
export const EditScheduleInput = z.object({
  title: z.string().min(1).optional(), description: z.string().optional(),
  runsAt: Iso.optional(), repeat: ScheduleRepeat.nullable().optional(),
  pages: z.array(Id).max(3).optional(), model: z.string().nullable().optional(),
  paused: z.boolean().optional(),
}).strict();
export type EditScheduleInput = z.infer<typeof EditScheduleInput>;
/**
 * `GET /api/buildings/:id/stats` (town planning's side bar, Mitchell's town hall mt_xywhisvdcm): the building's work right now.
 * `queued` = pending (blocked ones included; `blocked` counts those); `scheduled` = the building's active schedules; `agents` = named residents, `forks` = live
 * forks of its manager, `working` = of both, those in a work session; `host` = the live server's commit and when it started.
 */
export interface BuildingStats {
  assignments: { running: number; queued: number; blocked: number; scheduled: number };
  agents: number; forks: number; working: number;
  host: { commit: string | null; startedAt: string | null };
}
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
  /** wakes: the human behind it (a human's own tell, or a relay by an agent whose session has one) */
  origin: Origin.nullable().default(null),
  createdAt: Iso,
  readAt: Iso.nullable().default(null),
});
export type Message = z.infer<typeof Message>;

// ---------- meetings ----------
/** one-on-one: a human and the building's manager agent (docs/waterfall.md §3.4); opened from "Talk to ★", never scheduled */
/** in-tray-review, ad-hoc (and retro, planning): labels for history and filters, set by the "Call a meeting" preset; behaviour comes from `brings` and `askHumans` */
export const MeetingKind = z.enum(["standup", "retro", "planning", "town-hall", "one-on-one", "in-tray-review", "ad-hoc"]);
/**
 * What each attendee brings before the discussion (Lena's dc_tcoy1plt2r): `status` = the Did/Next/Need summary,
 * `nothing` = no collecting round (straight to discussion), `custom` = `text` replaces the Did/Next/Need instructions.
 */
export const MeetingBrings = z.object({ mode: z.enum(["status", "nothing", "custom"]).default("status"), text: z.string().max(500).default("") });
export type MeetingBrings = z.infer<typeof MeetingBrings>;
/** The literal docId of the review deck (GET /api/review-deck): it is computed from the in-tray, not a stored doc. */
export const REVIEW_DECK_ID = "review-deck";
/**
 * A presentation meeting's deck (design dc_y7a8g257of §1/§3): a deck doc (dc_…) or the review deck (REVIEW_DECK_ID),
 * the slide everyone sees (from 1), and the presenter: whoever called the meeting with it or last moved a slide (a holder id; null = the town).
 * The presenter alone sees the Notes line and the next slide's title.
 */
/**
 * The review deck as it stood when a meeting last presented or moved a slide (Mitchell, mt_xywhisvdcm decision 7): the
 * slide list stays pinned during the presentation, so deciding an item doesn't renumber the slides under the presenter.
 * Only what a slide needs once its item has left the in-tray: its text, and what identifies its decision.
 */
export const PinnedSlide = z.object({ key: z.string(), kind: z.string(), title: z.string().default(""), text: z.string().default(""), itemId: z.string().nullable().default(null), grantId: z.string().optional(), docIds: z.array(z.string()).optional() });
export type PinnedSlide = z.infer<typeof PinnedSlide>;
export const MeetingDeck = z.object({ docId: z.string().min(1), slide: z.number().int().positive().default(1), presenterId: Id.nullable().default(null), pinned: z.array(PinnedSlide).optional() });
export type MeetingDeck = z.infer<typeof MeetingDeck>;
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
  /** goal-directed budgets: the decision's lane (as `assign`); left out = directed (its source is the meeting when a human took part) */
  ...LaneFields.shape,
});
/**
 * What a speaker presents with an utterance (docs/meetings.md §8): a doc (title and opening lines kept as said), a town
 * page (`ref` bank, finance, dashboard, manual[/section], connect, grant:<id>, agent:<id>, building:<id>) or an uploaded
 * image or video (`url` /api/media/…). The meeting panel shows it inline; the notes keep the reference.
 */
export const MeetingAttachment = z.object({
  kind: z.enum(["doc", "page", "media"]),
  /** doc id, page ref, or media id */
  ref: z.string(),
  title: z.string(),
  /** doc: the opening of its body when it was presented */
  excerpt: z.string().optional(),
  /** media: where it is served */
  url: z.string().optional(),
});
export type MeetingAttachment = z.infer<typeof MeetingAttachment>;
export const MeetingUtterance = z.object({
  /** `system` for a line the town posts itself (speakerId "system"), e.g. a reply waiting on a redeploy */
  speakerId: Id,
  speakerKind: z.enum(["agent", "user", "system"]),
  text: z.string(),
  at: Iso,
  attachment: MeetingAttachment.optional(),
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
  /** the human's agenda items as numbered lines ("1. …"), or free text; "" = the facilitator proposes 2-4 items */
  agenda: z.string().default(""),
  brings: MeetingBrings.default({}),
  /** the facilitator opens with "Decisions needed from the humans" (default: kind is town-hall) */
  askHumans: z.boolean().default(false),
  /** Presentation with chat: the deck shown above the chat, kept in sync (null = a chat meeting) */
  deck: MeetingDeck.nullable().default(null),
  /** attendeeId -> short standup summary (did / next / need) submitted before discussion */
  summaries: z.record(z.string()).default({}),
  transcript: z.array(MeetingUtterance).default([]),
  decisions: z.array(MeetingDecision).default([]),
  notesDocId: Id.nullable().default(null),
  /** one-on-one: the human talking to the manager */
  withUserId: Id.nullable().default(null),
  createdAt: Iso,
  startedAt: Iso.nullable().default(null),
  endedAt: Iso.nullable().default(null),
});
export type Meeting = z.infer<typeof Meeting>;

// ---------- goal-directed budgets: grants and key results ----------
export const GrantStatus = z.enum([
  "draft",       // the manager is writing it
  "proposed",    // waiting for a human
  "countered",   // a human sent it back with changes; the manager's move
  "funded",      // sessions may draw on it
  "checkpoint",  // spend reached 100%: new sessions held until a human decides
  "closed",      // done: see outcome
  "rejected",
]);
export type GrantStatus = z.infer<typeof GrantStatus>;
/** done: the manager closed it early because the work is done (close_grant); "met" stays the human's word on the key result */
export const GrantOutcome = z.enum(["met", "stopped", "spent", "cut", "done"]);
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
/** One line of a grant's testing plan: how the plan's work will be checked (no status: status lives on the goal's key result). */
export const TestingPlanItem = z.object({ text: z.string().trim().min(1).max(300), howToCheck: z.string().trim().min(1).max(300) });
export type TestingPlanItem = z.infer<typeof TestingPlanItem>;
/**
 * A building's proposal and, once funded, its grant: the plan for one of the building goal's key results (objective,
 * approach, stop condition, optional testing plan) and a token ceiling (not a reservation). Funding it runs the plan.
 */
export const Grant = z.object({
  id: Id,
  buildingId: Id,
  /** the goal key result this grant works toward; null only for grants from before key results moved onto the goal (migration 032) */
  keyResultId: Id.nullable().default(null),
  objective: z.string().min(1).max(300),
  /** how: the approach the plan takes */
  approach: z.string().max(2000).default(""),
  /** how the work will be checked (what used to be the grant's own key results) */
  testingPlan: z.array(TestingPlanItem).default([]),
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
  /** the proposal's picture (an uploaded mf_… media id) and "what you'd see" line: the review deck's proposal slide (gr_jh0lu0w6yj step 4) */
  picture: z.string().nullable().default(null),
  whatYoudSee: z.string().default(""),
  /** spend fractions already checkpointed (1; a legacy 0.5 may remain), so each fires once per grantTokens value */
  checkpointsDone: z.array(z.number()).default([]),
  /** the manager's latest checkpoint report */
  checkpointDocId: Id.nullable().default(null),
  proposedBy: Id,
  /** a user id; never an agent */
  fundedBy: Id.nullable().default(null),
  /** the Bank input that pays its sessions first (a member funding it with their own input); null = the building's pool */
  fundedWith: Id.nullable().default(null),
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
/**
 * A key result of a building's goal: something a human can check in the live town. Humans write them (text,
 * howToCheck), and so does the building's own manager agent (listed in its next rollup); the manager sets status up to
 * `claimed`; `met` / `missed` only users with `building.fund`.
 */
export const KeyResult = z.object({
  id: Id,
  buildingId: Id,
  position: z.number().int(),
  text: z.string().min(1).max(300),
  howToCheck: z.string().min(1).max(300),
  status: KeyResultStatus.default("not-started"),
  statusNote: z.string().default(""),
  statusBy: Id.nullable().default(null),
  /** who wrote it and who last edited its words (a user id, or the manager agent's id): a manager may write its own building's */
  createdBy: Id.nullable().default(null),
  editedBy: Id.nullable().default(null),
  /** the meeting notes or reports it came from */
  sourceDocIds: z.array(Id).default([]),
  /** the building objective it serves (null = "Unsorted": not under an objective yet) */
  objectiveId: Id.nullable().default(null),
  updatedAt: Iso,
});
export type KeyResult = z.infer<typeof KeyResult>;
/** The town KPIs objectives move (docs/goal-directed-budgets.md "Objectives and KPIs"). */
export const KpiKey = z.enum(["fund", "join", "trust"]);
export type KpiKey = z.infer<typeof KpiKey>;
/** At most 3 objectives per building and 4 key results per objective (2 each is the hint, not enforced). */
export const MAX_OBJECTIVES = 3;
export const MAX_KEY_RESULTS_PER_OBJECTIVE = 4;
/**
 * An objective of a building goal: one sentence, a quarter horizon (e.g. "2026-Q4"), and the town KPI it moves. Key
 * results hang off it. Written like key results: a human with `building.manage` or the building's own manager agent.
 */
export const Objective = z.object({
  id: Id,
  buildingId: Id,
  position: z.number().int(),
  text: z.string().min(1).max(300),
  horizon: z.string().min(1).max(20),
  /** the town KPI it moves (null while drafting) */
  kpiId: Id.nullable().default(null),
  createdBy: Id.nullable().default(null),
  editedBy: Id.nullable().default(null),
  sourceDocIds: z.array(Id).default([]),
  updatedAt: Iso,
});
export type Objective = z.infer<typeof Objective>;
/** A standing town indicator (never met or missed); its value is computed live from town data. */
export const Kpi = z.object({
  id: Id,
  scope: z.literal("town").default("town"),
  key: KpiKey,
  name: z.string(),
  measure: z.string(),
  position: z.number().int(),
});
export type Kpi = z.infer<typeof Kpi>;
/** GET /api/kpis: a KPI with its live value: the last 7 days, the 7 before, and 8 weekly points (oldest first). */
export const KpiView = Kpi.extend({
  thisWeek: z.number().nonnegative(),
  lastWeek: z.number().nonnegative(),
  weeks: z.array(z.number().nonnegative()),
  /** one line on what this week's number is made of, e.g. "0 funders, 0 tokens" */
  detail: z.string(),
});
export type KpiView = z.infer<typeof KpiView>;
/** The framing the dashboard and the docs show above the KPI tiles. */
export const KPI_FRAMING = "The town goal, \"Make Muster Town something strangers can fund, join, and trust\", is not a key result anyone meets: it is three standing indicators, Fund, Join and Trust, that should rise week over week. Every building objective names the one it moves; key results are how a building commits to moving it this quarter, and these numbers are how the town sees whether it moved.";
/**
 * A grant as the API returns it: the goal key result it names (null if none) and derived spend. `spentTokens` is
 * adjusted output tokens (Bank step 3), like `askTokens` and `grantTokens`; `spentCounts` is the five counters behind it.
 */
export const GrantView = Grant.extend({
  keyResult: KeyResult.nullable(), spentTokens: z.number().int().nonnegative(), spentCounts: TokenCounts.optional(),
  fundedByName: z.string().nullable().optional(), fundedWithLabel: z.string().nullable().optional(),
});
export type GrantView = z.infer<typeof GrantView>;

// ---------- sessions (a resident's work session) ----------
export const SessionStatus = z.enum(["running", "done", "error", "interrupted"]);
export const Session = z.object({
  id: Id,
  agentId: Id,
  assignmentId: Id.nullable(),
  meetingId: Id.nullable().default(null),
  purpose: z.enum(["work", "manage", "review", "facilitate", "summary", "meeting-reply"]),
  /** where the session runs: in-process on the host, or inside the agent's desk container */
  backend: z.enum(["host", "docker"]).default("host"),
  status: SessionStatus,
  model: z.string(),
  sdkSessionId: z.string().nullable().default(null),
  /** the five counters (Bank grant step 1); `tokens` is their sum, derived by the database */
  ...TOKEN_COUNTS_SHAPE,
  tokens: z.number().int().default(0),
  /** the five counters per model id, when the session reported them (Bank step 2 prices each model at its own list price) */
  byModel: z.record(z.string(), TokenCounts).nullish(),
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
  /** wakes: the human behind the session, from its assignment or its meeting (null = none) */
  origin: Origin.nullish(),
  /**
   * Desk session performance (gr_uhh6u39vv9 step 1): wall-clock ms; CPU (user+nice+system) and steal ms from the desk
   * Machine's /proc/stat. A host session gets wallMs only (endedAt − startedAt); null = not measured (older sessions).
   */
  wallMs: z.number().int().nullish(),
  cpuMs: z.number().int().nullish(),
  stealMs: z.number().int().nullish(),
  /**
   * The desk Machine size the session ran on (gr_uhh6u39vv9 step 3, migration 060): Fly's guest as the runtime set it
   * at session start (performance 1 × 2048 normally, shared 2 × 2048 once the day's desk bill is over the cap).
   * null = a host session, a docker desk, or a session from before 060 (those ran on shared 2 × 2048).
   */
  cpuKind: z.enum(["shared", "performance"]).nullish(),
  cpus: z.number().int().nullish(),
  memoryMb: z.number().int().nullish(),
});
export type Session = z.infer<typeof Session>;
/** A session as the API serves it: with `adjustedOutputTokens` (Bank step 2), derived on read, never stored. */
export type SessionView = Session & { adjustedOutputTokens: number };

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
  "agent.tool", "agent.thought", "agent.banned", "agent.retired", "agent.forked", "agent.mentioned",
  "doc.created", "doc.updated", "doc.state", "doc.decision",
  "assignment.created", "assignment.status", "assignment.delegated", "schedule.created", "schedule.fired", "schedule.skipped", "schedule.edited", "schedule.ended",
  "meeting.created", "meeting.phase", "meeting.utterance", "meeting.decisions", "meeting.slide",
  "session.started", "session.ended",
  "building.created", "building.updated", "building.layout", "town.plan", "allocation.created", "budget.exhausted", "bank.input", "bank.credited", "bank.debited", "bank.converted", "bank.share", "bank.pool", "bank.drift", "bank.cap", "bank.hold",
  "grant.created", "grant.updated", "grant.proposed", "grant.countered", "grant.funded", "grant.rejected", "grant.checkpoint", "grant.closed", "kr.updated", "kr.created", "kr.deleted", "objective.created", "objective.updated", "objective.deleted", "building.blocked",
  "skill.used", "skill.pinned", "skill.unpinned",
  "secret.set", "secret.deleted", "secret.granted",
  "export.done", "system",
  /** the in-process monitor (packages/server/src/monitor.ts): an alert raised, re-sent, cleared, a test, or a gap in samples */
  "alert",
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

/** POST /api/buildings/:id/grants: a draft proposal (the manager): the plan for one goal key result. */
export const CreateGrantInput = z.object({
  keyResultId: Id.describe("the building goal's key result this grant works toward (one per grant)"),
  objective: z.string().trim().min(1).max(300),
  approach: z.string().trim().max(2000).default("").describe("how: the approach the plan takes"),
  stopCondition: z.string().trim().min(1).max(500),
  askTokens: z.number().int().positive(),
  testingPlan: z.array(TestingPlanItem).max(5).default([]).describe("optional: how the work will be checked, each line with a how-to-check"),
  findingsDocIds: z.array(Id).default([]),
  picture: z.string().trim().regex(/^mf_[a-z0-9]+$/, "an uploaded media id (mf_…)").optional().describe("optional: an uploaded picture (mf_…) of what the work would show; the review deck's proposal slide shows it"),
  whatYoudSee: z.string().trim().max(300).optional().describe("optional: one line on where a human would see the result in the live town and what they'd see; the review deck's proposal slide shows it"),
});
/** POST /api/buildings/:id/key-results: a key result on the building goal (humans with `building.manage`). */
export const CreateKeyResultInput = z.object({
  text: z.string().trim().min(1).max(300), howToCheck: z.string().trim().min(1).max(300),
  sourceDocIds: z.array(Id).max(10).default([]).describe("the meeting notes or reports it comes from"),
  objectiveId: Id.nullable().optional().describe("the objective of this building it serves (at most 4 key results each)"),
});
export type CreateKeyResultInput = z.input<typeof CreateKeyResultInput>;
/** POST /api/buildings/:id/objectives: an objective of the building goal (at most 3). `horizon` defaults to the current quarter. */
export const CreateObjectiveInput = z.object({
  text: z.string().trim().min(1).max(300), horizon: z.string().trim().regex(/^\d{4}-Q[1-4]$/).optional(),
  kpi: KpiKey.nullable().optional().describe("the town KPI it moves"),
  sourceDocIds: z.array(Id).max(10).default([]),
});
export type CreateObjectiveInput = z.input<typeof CreateObjectiveInput>;
/** PATCH /api/objectives/:id */
export const UpdateObjectiveInput = z.object({
  text: z.string().trim().min(1).max(300).optional(), horizon: z.string().trim().regex(/^\d{4}-Q[1-4]$/).optional(),
  kpi: KpiKey.nullable().optional(), sourceDocIds: z.array(Id).max(10).optional(), position: z.number().int().optional(),
});
export type UpdateObjectiveInput = z.input<typeof UpdateObjectiveInput>;
export type CreateGrantInput = z.input<typeof CreateGrantInput>;

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
    type: DocType.default("note").describe("'wiki' creates or rewrites your private page on the topic in `title` (your memory: shown to you at the start of every session); 'log' appends `body` as one dated line to your private log; 'deck' is slides: split on lines `---`, the first slide's `#` heading is the title, an optional last line `Notes: …` per slide is presenter-only"),
    title: z.string(),
    body: z.string(),
    state: z.enum(["draft", "building"]).default("draft").describe("'building' publishes it: type 'fyi' goes on the building's board, anything else is filed in its filing cabinet"),
    provenance: Provenance.optional(),
    tags: z.array(z.string()).optional(),
    topicOf: Id.optional().describe("type 'wiki' only: a building-owned topic page of this building (your building id) instead of a private page: published there, rewritten by its manager and the manager's forks (found by title within the building), every rewrite kept as a revision"),
    buildingId: Id.optional().describe("type 'fyi' only: the board to post to (default your building); \"town-hall\" posts a town-wide FYI that shows on every building's board (town admins and managers only)"),
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
    rollup: z.boolean().default(false).describe("Managers only: this report rolls up the residents' reports listed in provenance.sourceIds (required) for the Town Hall in-tray. Four sections (## Shipped, ## Decided, ## Key results, ## Needs from Mitchell; refused without them); each Shipped item has **What it is:**, **What you'd see:** (one cropped picture) and **Your call:** (warned without them). Needs never names an open proposal, outbox request or Town Hall in-tray report (refused); the town appends an \"Already waiting in your in-tray\" line."),
  }),
  request_human: z.object({ title: z.string(), body: z.string(), location: z.string().optional(), kind: z.enum(["observation", "data", "contact", "other"]).default("observation") }),
  assignments: z.object({}),
  accept_assignment: z.object({ id: Id }),
  meeting: z.object({
    meetingId: Id,
    action: z.enum(["status", "summary", "speak", "listen", "decide", "end"]),
    text: z.string().optional(),
    attach: z.string().optional().describe("speak only: present something with the line, shown inline in the meeting panel: a doc id (dc_…), an uploaded image or video (mf_… or its /api/media/… url), a grant (gr_…) or agent (ag_…), or a town page: bank, finance, dashboard, manual, connect, building:<id>"),
    decisions: z.array(MeetingDecision).optional(),
    waitSeconds: z.number().int().min(0).max(120).optional().describe("listen only: wait up to this long for someone to speak (default 0 = return now)"),
  }),
  // permissioned
  review: z.object({ docId: Id, decision: ReviewDecision.describe("approve = acknowledge only; continue = next assignment from the report's Proposal; redirect = next assignment from your note (required); stop = stop the agent. A flag (a human's quick request): continue = its text becomes assigneeId's directed assignment verbatim, redirect = your note does"), note: z.string().default(""),
    assigneeId: Id.optional().describe("a flag (continue/redirect): leave it out to queue it to the building (a fork of the manager runs it); or yourself, or a visitor of the building"),
    waitFor: WaitFor.optional().describe("continue/redirect: the new assignment waits for this before it starts"),
    ...LaneFields.shape }),
  assign: z.object({ agentId: Id.optional().describe("leave it out to queue it to the building (a fork of the manager runs it); or your own id to take it yourself, or a visitor's id to offer it to them"),
    title: z.string(), description: z.string(),
    pages: z.array(Id).max(3).optional().describe("topic pages (type wiki with topicOf) of this building that cover the work, at most 3: loaded into its fork's memory"),
    model: z.string().optional().describe("building-queue work only: the model its fork runs on, one the building allows (its model or cheapModel); default the building's model"),
    waitFor: WaitFor.optional().describe("don't start until this holds: {deploy: sha|\"next\"} (live after a redeploy), {assignment: id} (done or cancelled), {decision: reportId}. A job for a later time is a \`schedule\`, not a wait"),
    ...LaneFields.shape }),
  schedule: CreateScheduleInput.extend({
    scheduleId: Id.optional().describe("edit, pause or resume this schedule of my building (sc_…) instead of making one: give only what changes"),
    paused: z.boolean().optional().describe("with scheduleId: true pauses it (keeps its next run, does not fire), false resumes it"),
    title: z.string().min(1).optional().describe("required to make one"), description: z.string().optional().describe("required to make one"),
    runsAt: Iso.optional().describe("when it runs (ISO, at most 90 days ahead); left out with a repeat = its first occurrence"),
    repeat: ScheduleRepeat.nullable().optional().describe("repeat it every N hours or every day at UTC times, until a date (default 14 days, at most 90) or for a number of times; left out = runs once (with scheduleId: replaces the repeat, null makes it a one-shot)"),
    pages: z.array(Id).max(3).optional().describe("topic pages of this building for its fork's memory, at most 3"),
    model: z.string().optional().describe("forks buildings: the model its fork runs on (the building's model or cheapModel)"),
  }),
  cancel: z.object({ assignmentId: Id.optional().describe("a queued (not started) assignment in my building"), scheduleId: Id.optional().describe("or a schedule of my building (sc_…): it stops firing") }),
  propose_grant: CreateGrantInput.extend({
    note: z.string().max(2000).default("").describe("what the human should know when deciding"),
    grantId: Id.optional().describe("answer a counter: the countered proposal to rewrite with this plan and re-propose under its own id (leave it out for a new proposal)"),
  }),
  checkpoint_grant: z.object({
    grantId: Id, reportId: Id.optional().describe("an already filed checkpoint report; leave it out when you file the checkpoint first and then submit_report with rollup: true in this session (that report links itself)"),
    status: z.enum(["not-started", "on-track", "at-risk", "claimed"]).optional().describe("the grant's key result's status (only a human marks met or missed)"),
    note: z.string().max(2000).default("").describe("the evidence for that status"),
  }),
  close_grant: z.object({
    grantId: Id.describe("a funded (or checkpoint) grant of my building whose work is done"),
    note: z.string().trim().min(1).max(2000).describe("the evidence that the work is done: what a human can check in the live town; it becomes the key result's claimed note"),
    reportId: Id.optional().describe("an already filed report with the evidence; leave it out when you close first and then submit_report with rollup: true in this session (that report links itself as the close report)"),
  }),
  set_key_result: z.object({
    buildingId: Id.optional().describe("defaults to your building (a manager writes only its own building's)"),
    id: Id.optional().describe("a key result of that goal to edit; leave it out to add one"),
    text: z.string().trim().min(1).max(300).optional().describe("the key result: something a human can check in the live town (required to add one)"),
    howToCheck: z.string().trim().min(1).max(300).optional().describe("the measure / target: where to look and what you'd see (required to add one)"),
    sourceDocIds: z.array(Id).max(10).optional().describe("the meeting notes or report it comes from (required to add one)"),
    objectiveId: Id.nullable().optional().describe("the objective it serves (set_objective lists them; null moves it back to Unsorted)"),
  }),
  set_objective: z.object({
    buildingId: Id.optional().describe("defaults to your building"),
    id: Id.optional().describe("an objective to edit; leave it out to add one (at most 3 per building)"),
    text: z.string().trim().min(1).max(300).optional().describe("one sentence: what the building will achieve this quarter (required to add one)"),
    kpi: KpiKey.optional().describe("the town KPI it moves: fund, join or trust (required to add one)"),
    horizon: z.string().trim().regex(/^\d{4}-Q[1-4]$/).optional().describe("a quarter, e.g. 2026-Q4 (default: this quarter)"),
    sourceDocIds: z.array(Id).max(10).optional().describe("the meeting notes or report it comes from (required to add one)"),
  }),
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
  board: "List a building's board: building-wide FYIs (type \"fyi\") that everyone there needs to see, after the Town Hall's town-wide FYIs (marked townWide, listed first). Everything else published in the building (reports, meeting notes, articles, notes) is in its filing cabinet; `search` finds it.",
  search: "Full-text search over documents I can see (library, my building's board, my drafts).",
  read: "Read one document by id. For a skill (type \"skill\") it also lists the skill's bundled files; pass `file` to read one of them.",
  write: "Create or update a document. Drafts are private. State 'building' publishes it: type 'fyi' (a building-wide FYI everyone needs) goes on the board; anything else is filed in the building's filing cabinet.",
  skills: "List the skills I can use: those pinned into my sessions first, then my building's and the library's, with when to use each, their bundled files and how often they're used. `read` a skill to load it.",
  pin: "Pin a skill into sessions: scope agent (just me, `listed` only, unless I'm a manager), building (a manager) or town (an admin). Pins into others' sessions of skills with files, `always` pins for others, and town pins need a human. remove=true unpins.",
  submit_report: "End my work session with a report. Required at the end of every session. The report goes to my manager's in-tray and I go idle until someone gives me a new assignment. If I'm blocked waiting on something (a redeploy, a colleague's assignment, a review decision, a time), pass resumeWhen and next: my work parks and resumes by itself when that holds.",
  request_human: "Put a request in the town outbox for a human to do something in the real world (observe, fetch data, contact someone). Humans see it in the outbox at once and decide whether to do it.",
  assignments: "List my assignments.",
  accept_assignment: "Accept a pending assignment; it becomes my current task. Visitors: assignments to you are offers until you accept them (unaccepted offers are cancelled after 24 h); finish with `submit_report`.",
  meeting: "Participate in a meeting: 'summary' submits my short standup summary (did, next), 'speak' adds to the transcript once the discussion has started (attach presents a doc, a town page or an uploaded screenshot with it, shown inline to everyone), 'listen' returns new utterances since my last listen (set waitSeconds to wait for someone to speak), 'decide'/'end' are for the facilitator (to amend a decision, decide again with supersedes = its number in status's decisions list); a decision's waitFor holds its assignment until then, e.g. {deploy: \"next\"} for \"after the redeploy\" or {assignment: id} for \"once X lands\"; while humans are talking, leave 'end' to them.",
  review: "(manager/reviewer) Decide on a pending report in the in-tray: approve (acknowledge), continue (assign its proposal), redirect (assign your note instead), or stop the agent.",
  assign: "(manager/reviewer) Create an assignment for an agent in my building (with forks on, leave agentId out to queue it to the building). With waitFor it waits (e.g. for the next redeploy, or another assignment to finish) before it starts. In goal-directed buildings an agent must give lane grant (grantId of a funded grant; its key result is implied) or exploration (keyResultId of a goal key result with no funded grant, or gap), or directed when a human asked for it (sourceId: the human source; optionally keyResultId or gap, and then it runs until a grant proposal names that key result). Directed work is never held by the exploration allowance.",
  schedule: "(manager/reviewer) Put a timed job on my building's schedule: it runs at runsAt (once) or on a repeat (every N hours, or daily at UTC times) until an end. Nothing is pinned to an agent: each time it fires it creates one normal assignment on the building queue (a fork of the manager runs it), with the lane fields, pages and model given here (lanes as in assign, re-checked at every fire). Each fire is skipped (and logged) while the last fire's assignment is still queued or running; missed runs during downtime collapse into one. With scheduleId it edits, pauses (paused: true) or resumes (paused: false) one instead; `cancel` with scheduleId deletes it. Your own parked work still uses submit_report resumeWhen {after}.",
  cancel: "(manager/reviewer) Cancel a queued (not started) assignment in my building, or one of its schedules (scheduleId). Started assignments and other buildings' are refused.",
  propose_grant: "(manager) Propose a grant for my building in one call: the plan for one of the building goal's key results (keyResultId): an objective, the approach, a stop condition, a token ask, and optionally a testing plan (text + howToCheck lines). Funding it runs the plan. It goes to the Town Hall in-tray for a human to fund, counter or reject. A building can have several proposals open at once, each decided on its own. To answer a counter, pass its grantId: the new plan rewrites that proposal and re-proposes it under the same id.",
  checkpoint_grant: "(manager) File a grant's checkpoint: set the status of the grant's key result (on the building goal), at most claimed (only a human marks met or missed), with a note on the evidence; then submit_report with rollup: true, which links itself to the grant as its checkpoint report. The grant stays held until a human continues, adjusts or cuts it.",
  close_grant: "(manager) Close a funded grant early because its work is done: it closes as done, its key result goes to claimed with your note as the evidence, and the unspent tokens return to the Bank. Then submit_report with rollup: true (it links itself as the close report); a human marks the key result met or missed from the Town Hall in-tray. Use checkpoint_grant instead when the grant is held at its 100% checkpoint and the work is not done.",
  set_key_result: "(manager) Write a key result on my building's goal, or edit one (id): the text, how to check it, the meeting notes or report it comes from (sourceDocIds), and the objective it serves (objectiveId; at most 4 key results each). It's on the board at once and listed in my next rollup so a human can cut it. Status is checkpoint_grant's; only a human marks met or missed or deletes one.",
  set_objective: "(manager) Write an objective of my building's goal, or edit one (id): one sentence for this quarter, the town KPI it moves (fund, join or trust), the horizon (default this quarter) and the meeting notes or report it comes from. At most 3 per building; key results then hang off one (set_key_result objectiveId). Only a human deletes one.",
  promote: "(manager) Publish a document to the building (board if it's an fyi, else the filing cabinet) or promote it to the library.",
  ban: "(town moderator) Ban an agent town-wide pending review.",
  redeploy: "Pull main on the host, reinstall, rebuild the web client (and the desk image when image=true), then restart the collective's server. Use when Mitchell asks you to deploy or when main has changed and the running town is stale. The restart no longer waits for desk work sessions: yours keeps running through it (a town call during the few seconds the server is down is retried for you). Still never poll or wait for the new build in the same session: call it, say in your report which commit should be live, submit the report, and verify on your next session (park with resumeWhen {deploy: sha}).",
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
 * A goal-directed building's stoplight (town hall 2026-10-25): green = at least one funded grant running on every key
 * result, yellow = partly blocked (a key result with no funded grant, or a grant held at its checkpoint), red = fully
 * blocked (no key results, or no funded grant at all). `reason` is the one line shown on hover. Open-mode buildings and
 * the Town Hall have none (null).
 */
export const Stoplight = z.object({ light: z.enum(["green", "yellow", "red"]), reason: z.string() });
export type Stoplight = z.infer<typeof Stoplight>;
/** The stoplight rule, shared by core and the web mock: the goal's key results (each with its live grant) and the live (funded or checkpoint) grants. */
export function stoplightOf(keyResults: { grantId: string | null }[], live: { status: GrantStatus; objective: string }[]): Stoplight {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  if (!keyResults.length) return { light: "red", reason: "no key results to work toward" };
  if (!live.length) return { light: "red", reason: `no funded grant on ${keyResults.length === 1 ? "its key result" : `any of its ${keyResults.length} key results`}` };
  const held = live.filter((g) => g.status === "checkpoint");
  const unfunded = keyResults.filter((k) => !k.grantId).length;
  const why: string[] = [];
  if (held.length) why.push(held.length === 1 ? `grant "${held[0]!.objective}" is held at its checkpoint` : `${held.length} grants are held at their checkpoints`);
  if (unfunded) why.push(`${unfunded} of ${n(keyResults.length, "key result")} ${unfunded === 1 ? "has" : "have"} no funded grant`);
  if (why.length) return { light: "yellow", reason: why.join("; ") };
  return { light: "green", reason: `${n(live.length, "funded grant")} running on ${keyResults.length === 1 ? "its key result" : `all ${keyResults.length} key results`}` };
}

/**
 * A building as the snapshot / WS `building` message carries it: plus `intray`, the count of its pending reports,
 * `budget` (both derived, not stored; the map badges the manager's desk and labels the sign with them) and `stoplight`
 * (goal-directed buildings; the map's banner and the board show it).
 */
export const SnapshotBuilding = Building.extend({ intray: z.number().int().nonnegative().default(0), budget: BuildingBudget.optional(), stoplight: Stoplight.nullable().optional() });
export type SnapshotBuilding = z.infer<typeof SnapshotBuilding>;

/** A flag standing on the map: planted by a human, not yet picked up by its building's manager (nor decided). */
export const MapFlag = z.object({ docId: Id, buildingId: Id, x: z.number().int(), y: z.number().int(), title: z.string(), authorId: Id, createdAt: Iso });
export type MapFlag = z.infer<typeof MapFlag>;
/** The doc of a flag that stands on the map, as a MapFlag; null once it is picked up, decided, or never had a tile. */
export function mapFlagOf(d: Doc): MapFlag | null {
  if (d.type !== "flag" || !d.flagPos || d.pickedUpAt || d.decision !== "pending" || !d.buildingId) return null;
  return { docId: d.id, buildingId: d.buildingId, x: d.flagPos.x, y: d.flagPos.y, title: d.title, authorId: d.authorId, createdAt: d.createdAt };
}

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), avatarAgentId: Id.optional(), town: Town, buildings: z.array(SnapshotBuilding), agents: z.array(Agent), places: z.array(Place), flags: z.array(MapFlag).default([]), grid: z.object({ w: z.number(), h: z.number(), /** row-major tile kinds */ tiles: z.array(z.number()) }), meetings: z.array(Meeting), health: z.object({ docker: z.boolean(), slots: z.object({ running: z.number().int().nonnegative(), max: z.number().int().positive() }).optional() }).optional(),
    /** outbox requests nobody has claimed yet (requestStatus open): the badge on the map's outbox */
    outbox: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("event"), event: Event }),
  z.object({ type: z.literal("agent"), agent: Agent }),
  z.object({ type: z.literal("agents.pos"), positions: z.array(z.object({ id: Id, x: z.number(), y: z.number(), status: AgentStatus })) }),
  z.object({ type: z.literal("doc"), doc: Doc }),
  z.object({ type: z.literal("meeting"), meeting: Meeting }),
  z.object({ type: z.literal("building"), building: Building.extend({ intray: z.number().int().nonnegative().optional(), budget: BuildingBudget.optional(), stoplight: Stoplight.nullable().optional() }) }),
  z.object({ type: z.literal("assignment"), assignment: Assignment }),
  /** the outbox's unclaimed count changed (a request was filed, claimed or deleted) */
  z.object({ type: z.literal("outbox"), open: z.number().int().nonnegative() }),
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
  GRASS: 0, PATH: 1, FLOOR: 2, WALL: 3, DESK: 4, SHELF: 5, PLANT: 6, DOOR: 7, TABLE: 8, COUNTER: 9,
  /** the Town Hall map table (place `town-map`: using it opens town planning); was the trophy cases */
  TOWN_MAP: 10,
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
  /** a building's schedule board: a calendar on its back wall (place `schedule:<buildingId>`; the map marks its active schedules) */
  SCHEDULE_BOARD: 21,
  /** the Bank's stations (BANK_FIXTURES.stations): each opens one tab of the Bank panel */
  DONATION_BOX: 22, BANK_TICKER: 23, BANK_FOUNTAIN: 24, BANK_GAUGE: 25, BANK_LEDGER: 26, BANK_LOCKBOX: 27, BANK_SERVER: 28,
} as const;
/**
 * The Bank: a fixed landmark (not a building row, so it never takes a budget share) south of the road,
 * opposite the Town Hall, with its door in the top wall facing the road. Absolute tiles.
 */
export const BANK_LOT = { x: 48, y: 45, w: 17, h: 9 } as const;
/**
 * The Bank's interior, relative to BANK_LOT. Shared so core's layout and the web mock build the same room.
 * Every tab of the Bank panel is a thing in the room (Mitchell, 1:1 mt_ew2d0mm7h9): the vault (place `bank`) opens
 * Balance, each station (place `bank:<slug>`) its own tab; money in on the left, money out on the right.
 */
export const BANK_FIXTURES = {
  door: { x: 8, y: 0 },
  /** two columns framing the entrance */
  pillars: [{ x: 6, y: 1 }, { x: 10, y: 1 }],
  /** vault door in the back wall, gold bars stacked either side of the walk up to it; the `bank` place stands in front (Balance) */
  vault: { x: 8, y: 8 }, vaultStand: { x: 8, y: 7 },
  gold: [{ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 9, y: 7 }, { x: 10, y: 7 }],
  /** the town map on its stand (place `bank-map`: E zooms out to the coin flow); stand below it */
  map: { x: 14, y: 2 }, mapStand: { x: 14, y: 3 },
  stations: [
    { slug: "donate", tab: "Donate", name: "Donation box", tile: TILE.DONATION_BOX, cells: [{ x: 2, y: 2 }], stand: { x: 2, y: 3 } },
    { slug: "inputs", tab: "Inputs", name: "Inputs ticker", tile: TILE.BANK_TICKER, cells: [{ x: 4, y: 2 }], stand: { x: 4, y: 3 } },
    { slug: "pools", tab: "Pools", name: "Pools fountain", tile: TILE.BANK_FOUNTAIN, cells: [{ x: 2, y: 5 }, { x: 3, y: 5 }], stand: { x: 2, y: 6 } },
    { slug: "health", tab: "Health", name: "Pressure gauge", tile: TILE.BANK_GAUGE, cells: [{ x: 5, y: 5 }], stand: { x: 5, y: 6 } },
    { slug: "ledger", tab: "Ledger", name: "Ledger desk", tile: TILE.BANK_LEDGER, cells: [{ x: 11, y: 2 }, { x: 12, y: 2 }], stand: { x: 12, y: 3 } },
    { slug: "funding", tab: "Funding", name: "Lockboxes", tile: TILE.BANK_LOCKBOX, cells: [{ x: 11, y: 5 }, { x: 12, y: 5 }], stand: { x: 11, y: 6 } },
    { slug: "hosting", tab: "Hosting", name: "Server rack", tile: TILE.BANK_SERVER, cells: [{ x: 14, y: 5 }], stand: { x: 14, y: 6 } },
  ],
} as const;
/** The Bank panel's tabs, in order; Balance is the vault's. */
export const BANK_TABS = ["Balance", ...BANK_FIXTURES.stations.map((s) => s.tab)] as const;
/** The Bank tab a place opens: `bank` → Balance, `bank:<slug>` → its station's tab. */
export function bankTabOf(placeId: string): string {
  return BANK_FIXTURES.stations.find((s) => `bank:${s.slug}` === placeId)?.tab ?? "Balance";
}
/** The Bank's places: the vault's `bank` first (code finds the Bank by it), then one per station. Absolute tiles from the lot's corner. */
export function bankPlaces(x0: number, y0: number): Place[] {
  const F = BANK_FIXTURES;
  return [
    { id: "bank", kind: "bank", name: "Bank vault", buildingId: null, pos: { x: x0 + F.vaultStand.x, y: y0 + F.vaultStand.y } },
    ...F.stations.map((s): Place => ({ id: `bank:${s.slug}`, kind: "bank", name: `Bank ${s.name.toLowerCase()}`, buildingId: null, pos: { x: x0 + s.stand.x, y: y0 + s.stand.y } })),
    { id: "bank-map", kind: "bank-map", name: "Bank town map", buildingId: null, pos: { x: x0 + F.mapStand.x, y: y0 + F.mapStand.y } },
  ];
}
export const WALKABLE = new Set<number>([TILE.GRASS, TILE.PATH, TILE.FLOOR, TILE.DOOR]);

// ---------- REST payloads ----------
export const CreateBuildingInput = Building.pick({ name: true, goal: true, description: true, headcount: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, rules: true, codeAccess: true, managerAgentId: true }).partial({ goal: true, description: true, headcount: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, rules: true, codeAccess: true, managerAgentId: true });
/**
 * `poolId` moves the building to another Bank pool at once (admin only; null = General). `explorationTokensPerDay`
 * and `forks` need `building.fund` (a human), so a manager agent can't raise its own allowance.
 */
export const UpdateBuildingInput = CreateBuildingInput.partial().extend({
  poolId: Id.nullable().optional(),
  explorationTokensPerDay: z.number().int().nonnegative().nullable().optional(),
});
/** PATCH /api/grants/:id while draft / countered. `testingPlan` replaces the list. */
export const UpdateGrantInput = CreateGrantInput.partial().extend({ note: z.string().max(2000).optional() });
export type UpdateGrantInput = z.input<typeof UpdateGrantInput>;
/**
 * POST /api/grants/:id/decide (`building.fund`). On a proposed grant: fund (tokens default to the ask), counter
 * (edits + note, back to the manager), reject. On a checkpoint grant: continue, adjust (tokens/testing plan/stop condition), cut.
 * A member without `building.fund` may fund a proposed grant with `fundWith`: their own active input with the tokens.
 */
export const DecideGrantInput = z.object({
  action: z.enum(["fund", "counter", "reject", "continue", "adjust", "cut"]),
  tokens: z.number().int().positive().optional(),
  testingPlan: z.array(TestingPlanItem).max(5).optional(),
  stopCondition: z.string().trim().min(1).max(500).optional(),
  note: z.string().max(2000).default(""),
  /** fund only: pay its sessions from this Bank input of the funder's. Lets a member without `building.fund` fund it. */
  fundWith: Id.optional(),
  /** the review deck's slide (from 1) the decision was made on; recorded as the event's payload.deckSlide */
  deckSlide: z.number().int().positive().optional(),
  /** decided on a slide presented in this live meeting: also recorded as one of its decisions */
  meetingId: Id.optional(),
});
export type DecideGrantInput = z.input<typeof DecideGrantInput>;
/** POST /api/grants/:id/close: the manager may close as `stopped`; `building.fund` any outcome. */
export const CloseGrantInput = z.object({ outcome: GrantOutcome, note: z.string().max(2000).default("") });
export type CloseGrantInput = z.input<typeof CloseGrantInput>;
/**
 * PATCH /api/key-results/:id. `status`: the manager up to `claimed`; `building.fund` for `met` / `missed`.
 * `text` / `howToCheck` / `sourceDocIds`: humans with `building.manage`, or the building's own manager agent.
 */
export const UpdateKeyResultInput = z.object({
  status: KeyResultStatus.optional(),
  note: z.string().max(2000).default(""),
  text: z.string().trim().min(1).max(300).optional(),
  howToCheck: z.string().trim().min(1).max(300).optional(),
  /** replaces the list; only with a words edit */
  sourceDocIds: z.array(Id).max(10).optional(),
  /** move it under an objective of its building (null = back to Unsorted) */
  objectiveId: Id.nullable().optional(),
});
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
/** core `createResident` (seed, v0 import, a new building's manager): `name` left out or blank = the town picks an unused one. No REST route since 1:1 mt_wngibcr98b decision 1. */
export const CreateResidentInput = z.object({ buildingId: Id, name: z.string().trim().optional(), title: z.string().default(""), direction: z.string().default(""), sprite: z.number().int().optional(), model: z.string().optional() });
export const RegisterVisitorInput = z.object({ name: z.string(), buildingId: Id.optional(), title: z.string().optional(),
  /** default true: the visitor acts with its owner's permissions (capped by them) */
  inheritsOwner: z.boolean().optional() });
export const AgentPermissionsPatch = z.object({ inheritsOwner: z.boolean().optional(), deniedPermissions: z.array(Permission).optional() });
export type AgentPermissionsPatch = z.infer<typeof AgentPermissionsPatch>;
/** PATCH /api/agents/:id/model: the model for its work sessions; null = its home building's model. */
export const AgentModelPatch = z.object({ model: z.string().trim().min(1).nullable() });
export const ReviewInput = z.object({ decision: ReviewDecision, note: z.string().default(""), assigneeId: Id.optional(), waitFor: WaitFor.optional() });
/** POST /api/buildings/:id/flags: a human plants a flag (a short request) in a building; it lands in the manager's in-tray. */
export const PlantFlagInput = z.object({ text: z.string().trim().min(1).max(2000) });
export const ChatInput = z.object({ message: z.string(), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]) });
/** POST /api/docs/:id/reply: the reply text (empty = archive). */
export const ReplyInput = z.object({ text: z.string().default(""), deckSlide: z.number().int().positive().optional(), meetingId: Id.optional() });
export const InterruptInput = z.object({ text: z.string(), now: z.boolean().optional() });
/** POST /api/agents/:id/message: a human messages an agent (a `tell` from their avatar). `now` (default true) interrupts a working agent; false leaves it in the inbox. */
export const MessageAgentInput = z.object({ text: z.string().trim().min(1), now: z.boolean().default(true) });
export const WorkInput = z.object({ title: z.string().optional(), description: z.string().optional(), waitFor: WaitFor.optional(), ...LaneFields.shape });
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
export const CreateMeetingInput = z.object({ kind: MeetingKind.exclude(["one-on-one"]), buildingId: Id.nullable(), title: z.string().optional(), scheduledAt: Iso.optional(),
  /** a string, or agenda items (stored as numbered lines; blank items dropped) */
  agenda: z.union([z.string(), z.array(z.string())]).optional(), startNow: z.boolean().default(false),
  brings: MeetingBrings.optional(),
  /** omitted = kind is town-hall */
  askHumans: z.boolean().optional(),
  /** Mode "Presentation with chat": the deck doc id (type deck) or REVIEW_DECK_ID; omitted = chat */
  deck: z.object({ docId: z.string().trim().min(1) }).optional(),
  /** who to invite; omitted = the building's residents (town hall: managers, reviewers, moderators) */
  attendeeIds: z.array(Id).min(1).optional() });
/**
 * The "Call a meeting" presets (Lena's dc_tcoy1plt2r): each pre-fills the form and every field stays editable. The
 * preset is stored only as `kind` (a label); behaviour comes from `brings`, `askHumans` and the agenda. `attendees`:
 * `default` = the building's residents (Town Hall: managers, reviewers, moderators), `none` = pick by hand. `deck` set =
 * Mode "Presentation with chat" with that deck (Review the in-tray: the review deck).
 */
export const MEETING_PRESETS = [
  { id: "standup", label: "Standup", kind: "standup", attendees: "default", brings: { mode: "status", text: "" }, agenda: [], askHumans: false, deck: null },
  { id: "town-hall", label: "Town hall", kind: "town-hall", attendees: "default", brings: { mode: "status", text: "" }, agenda: [], askHumans: true, deck: null },
  { id: "in-tray-review", label: "Review the in-tray", kind: "in-tray-review", attendees: "default", brings: { mode: "nothing", text: "" },
    agenda: ["Read each in-tray item in one line with its ask; the human says approve / fund / counter / cut / later"], askHumans: true, deck: REVIEW_DECK_ID },
  { id: "retro", label: "Retro", kind: "retro", attendees: "default", brings: { mode: "custom", text: "What went well, what went badly, one thing to change, with evidence" }, agenda: [], askHumans: false, deck: null },
  { id: "planning", label: "Planning", kind: "planning", attendees: "default", brings: { mode: "custom", text: "The work you propose next and its cost in tokens" }, agenda: [], askHumans: true, deck: null },
  { id: "blank", label: "Blank", kind: "ad-hoc", attendees: "none", brings: { mode: "nothing", text: "" }, agenda: [], askHumans: false, deck: null },
] as const satisfies readonly { id: string; label: string; kind: Exclude<z.infer<typeof MeetingKind>, "one-on-one">; attendees: "default" | "none"; brings: MeetingBrings; agenda: readonly string[]; askHumans: boolean; deck: string | null }[];
export type MeetingPreset = (typeof MEETING_PRESETS)[number];
/** POST /api/meetings/:id/present: show `docId`'s slide `slide` above every attendee's chat; `docId` null stops presenting. */
export const MeetingPresentInput = z.object({ docId: z.string().trim().min(1).nullable(), slide: z.number().int().positive().default(1) });
export const MeetingSayInput = z.object({ text: z.string(), attach: z.string().optional() });
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
export const TownHealth = z.object({ docker: z.boolean(), slots: SessionSlots.optional(),
  /** a hosted collective only: whether it has an Anthropic API key of its own ("none": its agents are held) */
  funding: z.enum(["api-key", "none"]).optional() });
export type TownHealth = z.infer<typeof TownHealth>;

// ---------- access requests (a signed-in visitor asks to join; an admin lets them in as `member`) ----------
export const AccessRequestStatus = z.enum(["pending", "granted", "declined"]);
export const AccessRequest = z.object({
  id: Id,
  userId: Id,
  /** optional one line: what they'd like to do here */
  message: z.string().max(140).default(""),
  status: AccessRequestStatus.default("pending"),
  decidedBy: Id.nullable().default(null),
  createdAt: z.string(),
  decidedAt: z.string().nullable().default(null),
});
export type AccessRequest = z.infer<typeof AccessRequest>;
/** A Town Hall in-tray row: the request plus who asked. */
export type AccessRequestView = AccessRequest & { name: string; githubLogin: string | null; avatarUrl: string | null };
export const AccessRequestInput = z.object({ message: z.string().trim().max(140).optional() });
export const AccessDecisionInput = z.object({ grant: z.boolean() });

export const AuthMe = z.object({
  user: User, roles: z.array(Role), avatarAgentId: Id.nullable(), isAdmin: z.boolean(),
  /** holds `town.interact`: may move, talk and write; false = read-only until an admin lets them in */
  canInteract: z.boolean().default(true),
  /** the latest access request, if any */
  accessRequest: z.object({ status: AccessRequestStatus, message: z.string(), decidedAt: z.string().nullable() }).nullable().default(null),
});
export type AuthMe = z.infer<typeof AuthMe>;
/** `GET /api/auth/config`: what sign-in the server offers (`githubClientId` null = GitHub login not configured). */
/** `dev`: the server hands local browsers the admin token (`GET /api/dev/admin-token` exists); `session`: the request carries a valid sign-in cookie. Both let the client skip requests that would only fail. */
export const AuthConfig = z.object({ githubClientId: z.string().nullable(), publicUrl: z.string(), dev: z.boolean().optional(), session: z.boolean().optional() });
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
  /** a reviewer agent (role `reviewer`): may decide in the in-tray and facilitate; the manager agent, not the reviewer, works the in-tray */
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
  /** `fly` only: where desk Machines run, and their size (defaults iad, performance 1 vCPU, 2048 MB) */
  region: z.string().optional(),
  cpuKind: z.enum(["shared", "performance"]).optional(),
  cpus: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  /** sandbox backends (`fly`) only: the town's public base URL desks call back to (e.g. https://muster.town); docker desks use host.docker.internal */
  townUrl: z.string().url().optional(),
  /** where desks get GH_TOKEN: `gh auth token` on the host, the host's GH_TOKEN env, or none */
  ghToken: z.enum(["gh-cli", "env", "none"]).default("gh-cli"),
  /**
   * How many work sessions may run at once (a cost guard: on Fly each desk is its own Machine). Queued work waits for a
   * free slot; the scheduler never starts more. Changeable live (PUT /api/town/desks); a stored value wins over this default.
   */
  maxRunning: z.number().int().positive().default(30),
  /** how many days session transcripts are kept (docs/transcripts.md); collective.json `desks.transcriptDays` */
  transcriptDays: z.number().int().positive().default(90),
  /**
   * Town-wide desk bill cap, USD per UTC day (gr_uhh6u39vv9 step 3; Mitchell, 1:1 mt_s6f8mvjw9h): once the day's desk
   * sessions cost this much at Fly list prices, new desk sessions start on shared-cpu-2x instead of performance-1x
   * (never refused) and the monitor's `desk-bill` goes red. Stored in the meta row `desks`; PUT /api/town/desks changes it.
   */
  billCapUsd: z.number().nonnegative().default(10),
});
export type DesksConfig = z.infer<typeof DesksConfig>;
/** `PUT /api/town/desks` (admin): the host settings that can change while the server runs. */
export const DesksPatch = z.object({ maxRunning: z.number().int().positive().max(1000).optional(), billCapUsd: z.number().nonnegative().max(10_000).optional() })
  .refine((p) => p.maxRunning !== undefined || p.billCapUsd !== undefined, "give maxRunning or billCapUsd");
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
/**
 * What the desk parses the brief with: only the fields it reads, the rest passed through. A desk image often runs an
 * older commit than the server (it is rebuilt only with `redeploy image=true`), so a new enum value or field in
 * Agent, Building, Session, Town or Assignment must not stop a session from starting. The server builds the full
 * DeskBrief; the type check below keeps the view a subset of it.
 */
export const DeskBriefView = z.object({
  agent: z.object({ id: Id, name: z.string() }).passthrough(),
  building: z.object({ id: Id, name: z.string(), maxTurnsPerSession: z.number().int().positive().optional() }).passthrough(),
  town: z.object({}).passthrough(),
  assignment: z.object({ id: Id }).passthrough().nullable().optional(),
  session: z.object({ id: Id, model: z.string() }).passthrough(),
  system: z.string(),
  prompt: z.string(),
  workspace: DeskWorkspace.nullable().optional(),
});
export type DeskBriefView = z.infer<typeof DeskBriefView>;
type Assert<T extends true> = T;
/** fails to compile when DeskBrief stops being a valid DeskBriefView input (exported only so tsc keeps it) */
export type DeskBriefIsAView = Assert<DeskBrief extends z.input<typeof DeskBriefView> ? true : false>;

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
  /** `now`: interrupt the running turn instead of waiting for the next one (ops.pendingInterrupts) */
  interrupts: z.array(z.object({ id: Id, text: z.string(), from: z.string(), now: z.boolean().optional() })),
  stop: z.boolean(),
});
export type DeskControl = z.infer<typeof DeskControl>;

/** POST /api/agents/me/control/ack → 204 */
export const DeskControlAckInput = z.object({ ids: z.array(Id) });
export type DeskControlAckInput = z.infer<typeof DeskControlAckInput>;

/** POST /api/agents/me/session-end → { session } */
export const DeskSessionEndInput = z.object({
  session: Id,
  /** raw total: only read when `counts` is absent (an older desk), then split by the back-fill rule */
  tokens: z.number().nonnegative().default(0),
  /** the five counters, summed over every model the session used */
  counts: TokenCounts.optional(),
  /** the counters per model id (SDK `modelUsage` keys) */
  byModel: z.record(z.string(), TokenCounts).optional(),
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
  /** the SDK's message when it classified a result as SPEND_LIMIT (kept after a failover clears `error`); the server logs `bank.cap` */
  spendLimit: z.string().max(2000).optional(),
  /** the session's wall-clock ms, and the Machine's CPU and steal ms over it from /proc/stat (absent: an older desk, or unreadable) */
  wallMs: z.number().int().nonnegative().optional(),
  cpuMs: z.number().int().nonnegative().optional(),
  stealMs: z.number().int().nonnegative().optional(),
});
export type DeskSessionEndInput = z.infer<typeof DeskSessionEndInput>;

export { toJsonSchema } from "./json-schema.ts";
export * from "./tokens.ts";
export * from "./rollup.ts";
export * from "./deck.ts";
export * from "./desks.ts";
export { townEnv, townEnvBoth, ENV_PREFIX, OLD_ENV_PREFIX, type TownEnvName } from "./env.ts";
