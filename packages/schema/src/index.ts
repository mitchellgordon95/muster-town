/**
 * @agent-town/schema — the single source of truth for world state, documents,
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
export const Town = z.object({
  name: z.string(),
  goal: z.string(),
  tagline: z.string().default(""),
  goalNote: z.string().optional(),
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
});
export type User = z.infer<typeof User>;

// ---------- roles & permissions (Discord-style) ----------
export const Permission = z.enum([
  "town.manage_buildings",   // create/resize/delete buildings, set headcount
  "town.manage_roles",       // create roles, assign roles at town scope
  "town.allocate_budget",    // move donated tokens between buildings
  "town.approve_trophy",     // accept a trophy proposal
  "town.approve_request",    // make an outbox request visible to humans
  "building.manage",         // edit goal/description/policies, assign building roles
  "building.assign",         // create assignments for agents in the building
  "building.review",         // approve/redirect/stop reports
  "building.ban",            // ban an agent from the building (pending manager review)
  "building.promote",        // promote a doc from building -> library
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
    visitor: ["meeting.attend"] as Permission[],
  },
  building: {
    manager: [
      "building.manage", "building.assign", "building.review", "building.ban", "building.promote",
      "doc.write_building", "doc.propose_trophy", "doc.request_human", "meeting.facilitate", "meeting.attend",
    ] as Permission[],
    moderator: [
      "building.review", "building.ban", "building.promote", "building.assign",
      "doc.write_building", "doc.propose_trophy", "meeting.attend",
    ] as Permission[],
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
export const ReviewPolicy = z.enum(["human", "moderator", "auto"]);
export const MeetingCadence = z.object({
  kind: z.enum(["standup", "retro", "planning"]),
  /** minutes between meetings; 0 = manual only */
  everyMinutes: z.number().int().nonnegative(),
});
export const Lot = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });
export type Lot = z.infer<typeof Lot>;

/** Code access for a building's residents: a repo they may edit in a per-agent git worktree, with scoped tools. */
export const Workspace = z.object({
  /** repo root; relative paths resolve from the Agent Town repo root */
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
  /** when set, residents get code tools in a worktree of this repo during work sessions */
  workspace: Workspace.nullable().default(null),
  /** tile rectangle on the town grid; assigned by the server if absent */
  lot: Lot.optional(),
  createdAt: Iso,
  createdBy: Id.optional(),
});
export type Building = z.infer<typeof Building>;

/** Donated tokens allocated to a building from a user's donation. */
export const Allocation = z.object({
  id: Id,
  userId: Id,
  buildingId: Id,
  tokens: z.number().int().positive(),
  spentTokens: z.number().int().nonnegative().default(0),
  spentUsd: z.number().nonnegative().default(0),
  createdAt: Iso,
});
export type Allocation = z.infer<typeof Allocation>;

// ---------- agents (bodies in the world) ----------
export const AgentKind = z.enum(["resident", "visitor", "human", "service"]);
export const AgentStatus = z.enum([
  "idle", "walking", "working", "in-meeting", "awaiting-review", "out-of-budget", "stopped", "banned",
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
  /** persona + standing direction; shown on the agent card and used in prompts */
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
});
export type Agent = z.infer<typeof Agent>;

// ---------- places (named points on the map) ----------
export const PlaceKind = z.enum(["desk", "door", "library", "trophy-room", "outbox", "meeting-room", "plaza"]);
export const Place = z.object({
  id: Id,                 // e.g. "desk:<agentId>", "door:<buildingId>", "library", "meeting-room:<buildingId>"
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
  "meeting-notes",
  "request",       // outbox: a request for a human to do something in the world
  "human-report",  // inbox: a human's report back
  "assignment-proposal", // reserved
]);
export type DocType = z.infer<typeof DocType>;

export const DocState = z.enum(["draft", "building", "library", "trophy"]);
export type DocState = z.infer<typeof DocState>;

export const Verdict = z.enum(["continue", "pivot", "stop"]);
export const Decision = z.enum(["pending", "approve", "redirect", "stop"]);
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

// ---------- assignments ----------
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
  createdAt: Iso,
  updatedAt: Iso,
});
export type Assignment = z.infer<typeof Assignment>;

// ---------- messages (inbox) ----------
export const MessageKind = z.enum(["tell", "heard", "system", "meeting"]);
export const Message = z.object({
  id: Id,
  kind: MessageKind,
  fromId: Id,                 // agent or user id
  fromKind: z.enum(["agent", "user", "system"]),
  toId: Id,                   // agent id (inbox owner)
  body: z.string(),
  meetingId: Id.nullable().default(null),
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
  /** attendeeId -> three-line summary submitted before discussion */
  summaries: z.record(z.string()).default({}),
  transcript: z.array(MeetingUtterance).default([]),
  decisions: z.array(MeetingDecision).default([]),
  notesDocId: Id.nullable().default(null),
  createdAt: Iso,
  startedAt: Iso.nullable().default(null),
  endedAt: Iso.nullable().default(null),
});
export type Meeting = z.infer<typeof Meeting>;

// ---------- sessions (a resident's work session) ----------
export const SessionStatus = z.enum(["running", "done", "error", "interrupted"]);
export const Session = z.object({
  id: Id,
  agentId: Id,
  assignmentId: Id.nullable(),
  meetingId: Id.nullable().default(null),
  purpose: z.enum(["work", "review", "facilitate", "summary"]),
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
});
export type Session = z.infer<typeof Session>;

/** A human's message for an agent whose session runs outside the server process (queued; the desk polls). */
export const Interrupt = z.object({
  id: Id,
  agentId: Id,
  sessionId: Id.nullable().default(null),
  text: z.string(),
  from: z.string(),
  createdAt: Iso,
  deliveredAt: Iso.nullable().default(null),
});
export type Interrupt = z.infer<typeof Interrupt>;

// ---------- events (append-only activity log) ----------
export const EventType = z.enum([
  "agent.created", "agent.moved", "agent.status", "agent.activity", "agent.said", "agent.told",
  "agent.tool", "agent.thought", "agent.banned",
  "doc.created", "doc.updated", "doc.state", "doc.decision",
  "assignment.created", "assignment.status",
  "meeting.created", "meeting.phase", "meeting.utterance", "meeting.decisions",
  "session.started", "session.ended",
  "building.created", "building.updated", "allocation.created", "budget.exhausted",
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
  read: z.object({ id: Id }),
  write: z.object({
    id: Id.optional().describe("update an existing doc you authored"),
    type: DocType.default("note"),
    title: z.string(),
    body: z.string(),
    state: z.enum(["draft", "building"]).default("draft").describe("'building' publishes to your building's board"),
    provenance: Provenance.optional(),
    tags: z.array(z.string()).optional(),
  }),
  submit_report: z.object({
    title: z.string(),
    body: z.string().describe("Markdown with sections: Summary, What I did, Findings, Proposal for next session (or Post-mortem), For others, Questions for humans"),
    verdict: Verdict,
    provenance: Provenance.optional(),
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
  }),
  // permissioned
  review: z.object({ docId: Id, decision: z.enum(["approve", "redirect", "stop"]), note: z.string().default("") }),
  assign: z.object({ agentId: Id, title: z.string(), description: z.string() }),
  promote: z.object({ docId: Id, state: z.enum(["building", "library"]) }),
  ban: z.object({ agentId: Id, reason: z.string() }),
} as const;
export type VerbName = keyof typeof VerbInputs;
export const VERB_NAMES = Object.keys(VerbInputs) as VerbName[];

export const VERB_DESCRIPTIONS: Record<VerbName, string> = {
  look: "Where am I, who is nearby (agents and humans, what they're doing), what place this is, and my notices (unread messages, pending assignments, upcoming meetings).",
  go: "Walk to a place or to an agent. Returns when you arrive. Walking is free.",
  say: "Say something out loud; heard by everyone within 3 tiles (including humans).",
  tell: "Send a direct message to an agent's inbox.",
  inbox: "Read my messages (direct messages, things I heard, system notices, meeting invites).",
  board: "List recent documents published to a building's board (reports, articles, notes).",
  search: "Full-text search over documents I can see (library, my building's board, my drafts).",
  read: "Read one document by id.",
  write: "Create or update a document. Drafts are private; state 'building' publishes to my building's board.",
  submit_report: "End my work session with a report. Required at the end of every session. The building's review policy decides whether I continue.",
  propose_trophy: "Propose a library document for the trophy room (collective approval needed).",
  request_human: "Put a request in the town outbox for a human to do something in the real world (observe, fetch data, contact someone). A moderator approves it before humans see it.",
  assignments: "List my assignments.",
  accept_assignment: "Accept a pending assignment; it becomes my current task.",
  meeting: "Participate in a meeting: 'summary' submits my three-line summary, 'speak' adds to the transcript, 'listen' returns new utterances since my last listen, 'decide'/'end' are for the facilitator.",
  review: "(manager/moderator) Approve, redirect (with note), or stop an agent's report.",
  assign: "(manager/moderator) Create an assignment for an agent in my building.",
  promote: "(manager/moderator) Promote a document to the building board or the library.",
  ban: "(manager/moderator) Ban an agent from the building pending manager review.",
};

// ---------- verb results (what the LLM sees) ----------
export const NearbyAgent = z.object({ id: Id, name: z.string(), kind: AgentKind, status: AgentStatus, activity: z.string(), distance: z.number() });
export const LookResult = z.object({
  me: z.object({ id: Id, name: z.string(), status: AgentStatus, buildingId: Id.nullable(), place: z.string().nullable(), pos: Tile }),
  building: z.object({ id: Id, name: z.string(), goal: z.string() }).nullable(),
  nearby: z.array(NearbyAgent),
  notices: z.object({ unread: z.number().int(), pendingAssignments: z.number().int(), currentAssignment: z.string().nullable(), nextMeeting: z.object({ id: Id, title: z.string(), at: Iso, phase: MeetingPhase }).nullable() }),
  places: z.array(z.object({ id: Id, name: z.string(), kind: PlaceKind })).describe("places I can `go` to from here"),
});
export type LookResult = z.infer<typeof LookResult>;

// ---------- WebSocket protocol ----------
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), avatarAgentId: Id.optional(), town: Town, buildings: z.array(Building), agents: z.array(Agent), places: z.array(Place), grid: z.object({ w: z.number(), h: z.number(), /** row-major tile kinds */ tiles: z.array(z.number()) }), meetings: z.array(Meeting) }),
  z.object({ type: z.literal("event"), event: Event }),
  z.object({ type: z.literal("agent"), agent: Agent }),
  z.object({ type: z.literal("agents.pos"), positions: z.array(z.object({ id: Id, x: z.number(), y: z.number(), status: AgentStatus })) }),
  z.object({ type: z.literal("doc"), doc: Doc }),
  z.object({ type: z.literal("meeting"), meeting: Meeting }),
  z.object({ type: z.literal("building"), building: Building }),
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
export const TILE = { GRASS: 0, PATH: 1, FLOOR: 2, WALL: 3, DESK: 4, SHELF: 5, PLANT: 6, DOOR: 7, TABLE: 8, COUNTER: 9, TROPHY: 10 } as const;
export const WALKABLE = new Set<number>([TILE.GRASS, TILE.PATH, TILE.FLOOR, TILE.DOOR]);

// ---------- REST payloads ----------
export const CreateBuildingInput = Building.pick({ name: true, goal: true, description: true, headcount: true, reviewPolicy: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, workspace: true }).partial({ goal: true, description: true, headcount: true, reviewPolicy: true, model: true, cheapModel: true, maxTurnsPerSession: true, dailyTokensPerAgent: true, meetings: true, workspace: true });
export const UpdateBuildingInput = CreateBuildingInput.partial();
export const CreateResidentInput = z.object({ buildingId: Id, name: z.string(), title: z.string(), direction: z.string(), sprite: z.number().int().optional(), model: z.string().optional() });
export const RegisterVisitorInput = z.object({ name: z.string(), buildingId: Id.optional(), title: z.string().optional() });
export const ReviewInput = z.object({ decision: z.enum(["approve", "redirect", "stop"]), note: z.string().default("") });
export const ChatInput = z.object({ message: z.string(), history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]) });
export const InterruptInput = z.object({ text: z.string() });
export const WorkInput = z.object({ title: z.string().optional(), description: z.string().optional() });
export const DonateInput = z.object({ tokens: z.number().int().positive(), buildingId: Id, apiKey: z.string().optional() });
export const CreateMeetingInput = z.object({ kind: MeetingKind, buildingId: Id.nullable(), title: z.string().optional(), scheduledAt: Iso.optional(), agenda: z.string().optional(), startNow: z.boolean().default(false) });
export const MeetingSayInput = z.object({ text: z.string() });
export const SeedInput = z.object({ importDir: z.string().optional() });

export const AuthMe = z.object({ user: User, roles: z.array(Role), avatarAgentId: Id.nullable(), isAdmin: z.boolean() });
export type AuthMe = z.infer<typeof AuthMe>;

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
  /** workspace.path is relative to the collective dir */
  workspace: Workspace.optional(),
  residents: z.array(z.object({ name: z.string(), title: z.string(), direction: z.string(), sprite: z.number().int().optional(), model: z.string().optional() })).default([]),
  moderator: z.object({ name: z.string(), sprite: z.number().int().optional(), direction: z.string().optional() }).optional(),
  /** house allocation for this building, in tokens */
  houseTokens: z.number().int().nonnegative().optional(),
});
/** How resident work sessions run: in a desk container (docker), in-process (host), or docker when available (auto). */
export const DesksConfig = z.object({
  backend: z.enum(["docker", "host", "auto"]).default("auto"),
  image: z.string().default("agent-town-desk"),
  /** where desks get GH_TOKEN: `gh auth token` on the host, the host's GH_TOKEN env, or none */
  ghToken: z.enum(["gh-cli", "env", "none"]).default("gh-cli"),
});
export type DesksConfig = z.infer<typeof DesksConfig>;

export const CollectiveConfig = Town.extend({
  port: z.number().int().positive().optional(),
  desks: DesksConfig.optional(),
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
});
export type DeskSessionEndInput = z.infer<typeof DeskSessionEndInput>;
