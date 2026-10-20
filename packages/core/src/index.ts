/**
 * @agent-town/core — SQLite-backed world: store, layout/pathfinding/tick, verbs, permissions,
 * budgets, events, git export, v0 import, seed. No framework imports.
 */
export { World, type HostHooks, type SnapshotMessage } from "./world.ts";
export { AppError, forbidden, notFound, badRequest, isAppError, type ErrorCode } from "./errors.ts";
export { openDb, migrate, type DB } from "./db.ts";
export { Table, type ObjSchema, type TableOptions } from "./table.ts";
export { Memberships, Tokens, Users, TownMeta, type Repos, type TokenRow, type TokenKind } from "./store.ts";
export { EventLog, type NewEvent, type EventQuery, type EventType } from "./events.ts";
export { Permissions, holderOf, isAgent, townRoleId, buildingRoleId, type Holder, type BuildingRoleName, type TownRoleName } from "./permissions.ts";
export { Budget, type ChargeResult, type BudgetSummary } from "./budget.ts";
export { Ops, type Actor, type MessageAgentOptions, type MessageAgentResult, type RequestAction, type ThreadMessage } from "./ops.ts";
export { createBuilding, updateBuilding, createResident, registerVisitor, ensureAvatar, createUser, createServiceAgent, createTownModerator } from "./entities.ts";
export { migrateRoles, type MigrateRolesResult } from "./migrate-roles.ts";
export {
  applyDecision, createAssignment, createDoc, updateDoc, extractProposal, summarizeDoc, canSeeDoc, sendMessage,
  setAssignmentStatus, pendingQueue, nextPending, moveToFront, intrayOf, intrayCounts, requirePendingReport, type DocSummary,
} from "./domain.ts";
export { replyToReport, replyStamp, isMergeReply, MERGE_INSTRUCTION, type ReplyResult } from "./reply.ts";
export { extractMentions, notifyMentions, type MentionContext } from "./mentions.ts";
export { createMeeting, setMeetingPhase, meetingSpeak, meetingDecide, endMeeting, defaultAttendees, defaultFacilitator } from "./meetings.ts";
export { makeVerbs, verbImpls, type Verbs, type VerbResult } from "./verbs/index.ts";
export type { VerbIn, VerbRawIn } from "./verbs/types.ts";
export { HEARING_RANGE, nearbyAgents } from "./verbs/social.ts";
export { searchDocs, ftsQuery, boardDocs, cabinetDocs, cabinetCounts } from "./verbs/docs.ts";
export { exportWorld, importExport, docExportPath, type ExportResult } from "./export.ts";
export { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
export { seedDefaults, originUrl, HOUSE_BUDGET_TOKENS, type SeedOptions, type SeedResult } from "./seed.ts";
export * as prompts from "./prompts.ts";
export * from "./prompts.ts";
export {
  computeLayout, assignLots, labSize, tileAt, ROAD_Y, TOWN_HALL_X, TOWN_HALL_ID, TOWN_HALL_SIZE, LOT_GAP, MAX_HEADCOUNT, MOD_SEATS, TOWN_HALL_FIXTURES,
  type Grid, type DeskSlot, type LayoutResult,
} from "./world/layout.ts";
export { findPath, isWalkable } from "./world/path.ts";
export { WorldMap } from "./world/map.ts";
export { Movement, WALK_TILES_PER_SEC, WALK_TIMEOUT_MS } from "./world/movement.ts";
export { Emitter, newId, newToken, nowIso, chebyshev, slugify, parseFrontmatter, stringifyFrontmatter, extractSection, firstLine } from "./util.ts";
