/**
 * @muster-town/core — SQLite-backed world: store, layout/pathfinding/tick, verbs, permissions,
 * budgets, events, git export, v0 import, seed. No framework imports.
 */
export { World, type HostHooks, type SnapshotMessage } from "./world.ts";
export { AppError, forbidden, notFound, badRequest, isAppError, type ErrorCode } from "./errors.ts";
export { openDb, migrate, integrityCheck, sealCopy, type DB } from "./db.ts";
export { Table, whereOf, type ObjSchema, type SqlFragment, type TableOptions } from "./table.ts";
export { Memberships, Tokens, Users, BankInputs, TownMeta, type Repos, type TokenRow, type TokenKind } from "./store.ts";
export { EventLog, type NewEvent, type EventQuery, type EventType } from "./events.ts";
export { Permissions, holderOf, isAgent, townRoleId, buildingRoleId, type Holder, type BuildingRoleName, type TownRoleName } from "./permissions.ts";
export { Budget, PLACEHOLDER_LABEL, startOfLocalDay, type ChargeResult, type BudgetSummary, type Funding } from "./budget.ts";
export { previousUtcDay, utcDay } from "./drift.ts";
export { reconcileFunding, reconciled, type ReconcileResult } from "./reconcile.ts";
export { Skills, parseSkillMd, skillsBlock, type SessionSkill, type SkillMd } from "./skills.ts";
export { forkStatus, ToolResults, resultLine, inputLine, type ForkStatus, type ForkStatusCall } from "./forkstatus.ts";
export { Transcripts, TRANSCRIPT_DEFAULT_DAYS, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_UPLOAD, brotli, type TranscriptInfo } from "./transcripts.ts";
export { Media, MEDIA_MAX_BYTES, MEDIA_DAILY_BYTES, MEDIA_TYPES, mediaUrl, type MediaInfo } from "./media.ts";
export { Secrets, REPO_TOKEN_SECRET, dataKeyFrom, encryptSecret, decryptSecret } from "./secrets.ts";
export { townKpis, kpiByKey, KPI_WEEKS, JOIN_RETURN_DAYS } from "./kpis.ts";
export { Goals, type GoalNode, type GoalProposalView } from "./goals.ts";
export { Streams } from "./streams.ts";
export { funderWeek, funderWeights } from "./funders.ts";
export { Reorgs, REORG_PREP_MS, PLANNER_TITLE, PLANNER_UNPAID } from "./goal-changes.ts";
export { Grants, quarterOf, type ObjectiveView, type ObjectiveTree, CHECKPOINTS, BLOCKED_NO_KRS, type ExplorationBudget, type DirectedBudget, type GrantBoard, type GoalKeyResult, type BlockedBuilding } from "./grants.ts";
export { BANK_ACCOUNTING, Bank, NO_KEY_HOLD, NO_TOKEN_HOLD, NoCredential, TOKEN_PRICES, type Credential, adjustedOfUsage, booked, sliceBooked, type Booked, adjustedOutputTokens, listCostUsd, sessionView, tokenPrices, tokenWeights, type BankContributor, type BankSummary } from "./bank.ts";
export { financeSummary, townFinance, FINANCE_BURN_DAYS, FINANCE_PROJECTION_DAYS, type FinanceInputs, type FinanceSummary, type OverdrawnBreakdown } from "./finance.ts";
export { goalSpend, worldGoalSpend, type GoalSpendInputs } from "./goal-spend.ts";
export { buildingBoard, goalBoard, queueLane, QUEUE_DONE_MS } from "./kanban.ts";
export { linkPostmortem, postmortemBuilding, postmortemNote, postmortemTag, queuePostmortem } from "./postmortems.ts";
export { intrayRoutes } from "./intray-routes.ts";
export { bankConvertedAt, countersSince, financeSpend, grantTitle, ledgerBookedBeforeConversion, townSpend, NO_ASSIGNMENT, NO_BUILDING, NO_GRANT, NOT_FUNDED, SPEND_IDENTITY, UNATTRIBUTED, WEIGHT_MISMATCH, type FinanceSpend, type SpendInputs, type SpendKind, type SpendNode } from "./finance-spend.ts";
export { financeSources, townSources, DELETED_INPUT, SOURCES_IDENTITY, type FinanceSources, type SourceCredit, type SourceDonation, type SourceInput, type SourcesInputs } from "./finance-sources.ts";
export { financeFly, flyRate, townFly, DESK_MACHINE_DEFAULTS, FLY_IDENTITY, FLY_NOT_COUNTED, FLY_PRICES, TOWN_MACHINE, type FinanceFly, type FlyBuilding, type FlyDay, type FlyDayBuilding, type FlyInputs, type FlyRate } from "./finance-fly.ts";
export { deskPreset, deskSizeFor, DESK_FALLBACK_SIZE, type DeskBill, type DeskSize } from "./desk-bill.ts";
export { EXPLORE_CHUNK_TOKENS, exploreCapAt, exploreRuleAt, exploreSpentToday, freeTokens, freeTokensAll, goalFunding } from "./free-tokens.ts";
export { EXPLORE_CEILING_SHARE, EXPLORE_MIN_GAP_MS, assignmentSpent, exploreBlock, exploreTick, reservationLeft } from "./explore.ts";
export { Ops, type Actor, type RequestAction, type ThreadMessage } from "./ops.ts";
export { createBuilding, STARTER_MANAGER_MODEL, updateBuilding, syncManagerRoles, createResident, registerVisitor, ensureAvatar, createUser, createServiceAgent, createTownModerator, updateFurniture, followRelayout } from "./entities.ts";
export { RESIDENT_NAMES, suggestResidentName } from "./names.ts";
export { forkManager, retireFork, nextForkN, forkModels, checkForkModel, forkableQueue, freeDesks, liveForks, chainDesk, deskSlotRow, deskSlotRows, setDeskSlot, forkDeskSlot, type DeskSlotRow, forkSummary, forksOf, familySpend, type FamilySpend, reportChain, reportChains, requestForkStop, stopOverdueForks, STOP_FORK_TIMEOUT_MS, type ForkSummary, type ReportChain } from "./forks.ts";
export { decisionKey, decisionWakes, managerIntrayRow, mentionKey, mentionWake, relayKey, relayWake, RELAY_MAX_AGE_MS, RELAY_MAX_HOPS, requestAnswerKey, requestAnswerWake, wakeKey } from "./wakes.ts";
export { chainTip, checkWaits, describeWait, validateWait, waitMet } from "./waits.ts";
export { blockedBy, buildingStats, waitsOnTime, townBlocked } from "./blockers.ts";
export { attachablePages, buildingSchedules, cancelSchedule, createSchedule, describeRepeat, editSchedule, endSchedule, fireSchedules, nextOccurrence, scheduleTaker, townSchedules, DEFAULT_SCHEDULE_DAYS, MAX_SCHEDULE_DAYS } from "./schedules.ts";
export { Presence, STAMP_EVERY_MS, OFFLINE_AFTER_MS, PRESENCE_TICK_MS, OFFER_TTL_MS, type TouchResult } from "./presence.ts";
export { upsertGithubUser, type GithubProfile, type GithubUpsertResult } from "./github-users.ts";
export { requestAccess, decideAccess, pendingAccessRequests, pendingAccessCount, accessRequestOf, canInteract, parseAccessMessage, ASK_AGAIN_MS } from "./access.ts";
export { migrateRoles, type MigrateRolesResult } from "./migrate-roles.ts";
export {
  applyDecision, createAssignment, createDoc, updateDoc, extractProposal, summarizeDoc, canSeeDoc, sendMessage,
  setAssignmentStatus, pendingQueue, nextPending, nextStartable, buildingQueue, moveToFront, intrayOf, intrayCount, intrayCounts, townHallIntray, grantsAwaitingDecision,
  managerAgentOf, intrayWorker, isTownHallItem, requirePendingReport, plantFlag, pickUpFlag, flagPlaceId, type DocSummary,
} from "./domain.ts";
export { archiveReport, type ArchiveResult } from "./archive.ts";
export { extractMentions, notifyMentions, type MentionContext } from "./mentions.ts";
export { createMeeting, createOneOnOne, setMeetingPhase, meetingSpeak, meetingNotice, SYSTEM_SPEAKER, meetingDecide, endMeeting, type MeetingBy, humanTyping, defaultAttendees, defaultFacilitator, previousMeeting, agendaText, bringsLine, decisionOutcomes, type DecisionOutcome, presentSlide, currentSlide, deckSlides, slideLine, recordSlideDecision, type CurrentSlide } from "./meetings.ts";
export { makeVerbs, verbImpls, type Verbs, type VerbResult } from "./verbs/index.ts";
export type { VerbIn, VerbRawIn } from "./verbs/types.ts";
export { HEARING_RANGE, nearbyAgents } from "./verbs/social.ts";
export { searchDocs, ftsQuery, boardDocs, boardWithTownDocs, townBoardDocs, canPostTownBoard, unpublishTownFyi, canEditBoardNote, editBoardNote, cabinetDocs, cabinetCounts } from "./verbs/docs.ts";
export { exportWorld, importExport, docExportPath, type ExportResult } from "./export.ts";
export { importV0, type ImportV0Options, type ImportV0Result } from "./import-v0.ts";
export { seedDefaults, seedManual, findManual, MANUAL_TAG, originUrl, HOUSE_BUDGET_TOKENS, HOUSE_LABEL, type SeedOptions, type SeedResult } from "./seed.ts";
export * as prompts from "./prompts.ts";
export * from "./prompts.ts";
export * from "./memory.ts";
export {
  computeLayout, labSize, tileAt, TOWN_HALL_ID, TOWN_HALL_SIZE, MAX_HEADCOUNT, MOD_SEATS, TOWN_HALL_FIXTURES,
  type Grid, type DeskSlot, type LayoutResult,
} from "./world/layout.ts";
export { deriveRoads, doorOf, doorstepOf, facesNorth, type Roads } from "./world/road.ts";
export { treeLayout, type TreeLayout, type TreeGoal, type TreeBuilding, type Plaza } from "./world/tree.ts";
export { findPath, isWalkable, nearestWalkable } from "./world/path.ts";
export { piecesFor, validateLayout, resolveFurniture, movedOnly, type Piece, type Furniture, type LayoutError } from "./world/furniture.ts";
export { WorldMap } from "./world/map.ts";
export { Movement, WALK_TILES_PER_SEC, WALK_TIMEOUT_MS } from "./world/movement.ts";
export { Emitter, newId, newToken, nowIso, chebyshev, slugify, parseFrontmatter, stringifyFrontmatter, extractSection, firstLine } from "./util.ts";
export { reviewDeck, presentedReviewDeck, decisionWaiters, grantHistoryLine, rollupHistoryLine } from "./review-deck.ts";
export { stamp, fromNow, whenFor, waitedFor, clockLine, guessedTimes, guessedTimesWarning } from "./time.ts";
export { actOrigin } from "./origin.ts";
export { stayReason, TALK_MS, walkHome, walkIdleHome } from "./home.ts";
