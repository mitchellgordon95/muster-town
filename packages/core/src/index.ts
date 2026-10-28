/**
 * @muster-town/core — SQLite-backed world: store, layout/pathfinding/tick, verbs, permissions,
 * budgets, events, git export, v0 import, seed. No framework imports.
 */
export { NO_KEY_HOLD, World, type HostHooks, type SnapshotMessage } from "./world.ts";
export { AppError, forbidden, notFound, badRequest, isAppError, type ErrorCode } from "./errors.ts";
export { openDb, migrate, integrityCheck, sealCopy, type DB } from "./db.ts";
export { Table, type ObjSchema, type TableOptions } from "./table.ts";
export { Memberships, Tokens, Users, BankInputs, TownMeta, type Repos, type TokenRow, type TokenKind } from "./store.ts";
export { EventLog, type NewEvent, type EventQuery, type EventType } from "./events.ts";
export { Permissions, holderOf, isAgent, townRoleId, buildingRoleId, type Holder, type BuildingRoleName, type TownRoleName } from "./permissions.ts";
export { Budget, PLACEHOLDER_LABEL, startOfLocalDay, type ChargeResult, type BudgetSummary } from "./budget.ts";
export { Skills, parseSkillMd, skillsBlock, type SessionSkill, type SkillMd } from "./skills.ts";
export { Transcripts, TRANSCRIPT_DEFAULT_DAYS, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_UPLOAD, brotli, type TranscriptInfo } from "./transcripts.ts";
export { Media, MEDIA_MAX_BYTES, MEDIA_DAILY_BYTES, MEDIA_TYPES, mediaUrl, type MediaInfo } from "./media.ts";
export { Secrets, REPO_TOKEN_SECRET, dataKeyFrom, encryptSecret, decryptSecret } from "./secrets.ts";
export { townKpis, kpiByKey, KPI_WEEKS, JOIN_RETURN_DAYS } from "./kpis.ts";
export { Grants, quarterOf, type ObjectiveView, type ObjectiveTree, EXPLORATION_SHARE, CHECKPOINTS, BLOCKED_NO_KRS, type ExplorationBudget, type DirectedBudget, type GrantBoard, type GoalKeyResult, type BlockedBuilding } from "./grants.ts";
export { BANK_ACCOUNTING, Bank, TOKEN_PRICES, adjustedOfUsage, booked, sliceBooked, type Booked, adjustedOutputTokens, listCostUsd, sessionView, tokenPrices, tokenWeights, type BankContributor, type BankSummary } from "./bank.ts";
export { financeSummary, townFinance, FINANCE_BURN_DAYS, FINANCE_PROJECTION_DAYS, type FinanceInputs, type FinanceSummary, type OverdrawnBreakdown } from "./finance.ts";
export { bankConvertedAt, countersSince, financeSpend, ledgerBookedBeforeConversion, townSpend, NO_ASSIGNMENT, NO_BUILDING, NO_GRANT, NOT_FUNDED, SPEND_IDENTITY, UNATTRIBUTED, WEIGHT_MISMATCH, type FinanceSpend, type SpendInputs, type SpendKind, type SpendNode } from "./finance-spend.ts";
export { Ops, type Actor, type MessageAgentOptions, type MessageAgentResult, type RequestAction, type ThreadMessage } from "./ops.ts";
export { createBuilding, updateBuilding, syncManagerRoles, createResident, registerVisitor, ensureAvatar, createUser, createServiceAgent, createTownModerator, updateFurniture, planTown } from "./entities.ts";
export { RESIDENT_NAMES, suggestResidentName } from "./names.ts";
export { forkManager, retireFork, nextForkN, familyCap, forkModels, checkForkModel, forkableQueue, freeDesks, liveForks, chainDesk, deskSlotRow, deskSlotRows, setDeskSlot, forkDeskSlot, type DeskSlotRow, forkSummary, forksOf, familySpend, type FamilySpend, reportChain, reportChains, type ForkSummary, type ReportChain } from "./forks.ts";
export { decisionKey, decisionWakes, managerIntrayRow, mentionKey, mentionWake, relayKey, relayWake, RELAY_MAX_AGE_MS, RELAY_MAX_HOPS, requestAnswerKey, requestAnswerWake, wakeKey } from "./wakes.ts";
export { checkWaits, describeWait, validateWait, waitMet } from "./waits.ts";
export { blockedBy, townBlocked } from "./blockers.ts";
export { Presence, STAMP_EVERY_MS, OFFLINE_AFTER_MS, PRESENCE_TICK_MS, OFFER_TTL_MS, type TouchResult } from "./presence.ts";
export { upsertGithubUser, type GithubProfile, type GithubUpsertResult } from "./github-users.ts";
export { requestAccess, decideAccess, pendingAccessRequests, pendingAccessCount, accessRequestOf, canInteract, parseAccessMessage, ASK_AGAIN_MS } from "./access.ts";
export { migrateRoles, type MigrateRolesResult } from "./migrate-roles.ts";
export {
  applyDecision, createAssignment, createDoc, updateDoc, extractProposal, summarizeDoc, canSeeDoc, sendMessage,
  setAssignmentStatus, pendingQueue, nextPending, nextStartable, buildingQueue, moveToFront, intrayOf, intrayCount, intrayCounts, townHallIntray, grantsAwaitingDecision,
  managerAgentOf, intrayWorker, isTownHallItem, requirePendingReport, plantFlag, pickUpFlag, flagPlaceId, type DocSummary,
} from "./domain.ts";
export { replyToReport, replyStamp, isMergeReply, MERGE_INSTRUCTION, type ReplyResult } from "./reply.ts";
export { extractMentions, notifyMentions, type MentionContext } from "./mentions.ts";
export { createMeeting, createOneOnOne, setMeetingPhase, meetingSpeak, meetingNotice, SYSTEM_SPEAKER, meetingDecide, endMeeting, type MeetingBy, humanTyping, defaultAttendees, defaultFacilitator, previousMeeting, decisionOutcomes, type DecisionOutcome } from "./meetings.ts";
export { makeVerbs, verbImpls, type Verbs, type VerbResult } from "./verbs/index.ts";
export type { VerbIn, VerbRawIn } from "./verbs/types.ts";
export { HEARING_RANGE, nearbyAgents } from "./verbs/social.ts";
export { searchDocs, ftsQuery, boardDocs, boardWithTownDocs, townBoardDocs, canPostTownBoard, cabinetDocs, cabinetCounts } from "./verbs/docs.ts";
export { exportWorld, importExport, docExportPath, type ExportResult } from "./export.ts";
export { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
export { seedDefaults, seedManual, findManual, MANUAL_TAG, originUrl, HOUSE_BUDGET_TOKENS, HOUSE_LABEL, type SeedOptions, type SeedResult } from "./seed.ts";
export * as prompts from "./prompts.ts";
export * from "./prompts.ts";
export * from "./memory.ts";
export {
  computeLayout, assignLots, labSize, tileAt, ROAD_Y, TOWN_HALL_X, TOWN_HALL_ID, TOWN_HALL_SIZE, LOT_GAP, MAX_HEADCOUNT, MOD_SEATS, TOWN_HALL_FIXTURES,
  type Grid, type DeskSlot, type LayoutResult,
} from "./world/layout.ts";
export { facesNorth } from "./world/road.ts";
export { findPath, isWalkable, nearestWalkable } from "./world/path.ts";
export { validatePlan, planLot, doorOf, MAX_LOT, MAX_TOWN_X, MAX_TOWN_Y, type PlanError, type PlanLot } from "./world/plan.ts";
export { piecesFor, validateLayout, resolveFurniture, movedOnly, type Piece, type Furniture, type LayoutError } from "./world/furniture.ts";
export { WorldMap } from "./world/map.ts";
export { Movement, WALK_TILES_PER_SEC, WALK_TIMEOUT_MS } from "./world/movement.ts";
export { Emitter, newId, newToken, nowIso, chebyshev, slugify, parseFrontmatter, stringifyFrontmatter, extractSection, firstLine } from "./util.ts";
