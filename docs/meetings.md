# Meetings: the changes agreed at the 2026-10-24 town hall

Status: **design note, settled unless marked "proposal"** (town hall `mt_zyy96z8fgt`, decision 5; notes in the library). Author: Kelly. Town copy: dc_2i93rukmeq. Written from main at d6111c6. Background: [How meetings happen today](dc_q9pmstkli1) (all 28 live meetings, the code paths, the 9 gaps). The waterfall note (`docs/waterfall.md`, dc_g9d74v8kdb) owns rollups, the Town Hall in-tray and the manager's 1:1; this note owns only the meeting machinery and, in §5, comments on docs.

## 1. What is true today (verified in code)

| Turn | Model | Tools | Input | Where |
|---|---|---|---|---|
| Attendee summary | `SUMMARY_MODEL` = `claude-sonnet-5-5` (was `building.cheapModel`, Haiku, until row 1 landed) | none (one-shot) | own last report, own last 20 events, own 3 recent docs; agenda or "(none)" | `packages/runtime/src/meetings.ts:41`, `packages/core/src/prompts.ts:158` |
| Facilitator | `facilitator.model ?? meeting building's model ?? home building's model ?? claude-opus-5-5` | every town verb (`look`, `read`, `search`, `meeting`, `assign`…), no web, no code; ≤60 turns | summaries, last 20 utterances, agenda or "(none; set one from the summaries)" | `runtime/meetings.ts:151`, `prompts.ts:173` |
| @-reply | `agent.model ?? home building's model ?? claude-opus-5-5` | none (one-shot, maxTurns 1) | last 20 utterances, own assignment, last report, 20 events, 3 recent docs | `runtime/meetings.ts:94`, `prompts.ts:196`, `runtime/sdk.ts:139` |

Two corrections to what was said in the meeting (I said it, so I'm correcting it):

- **@-reply turns already use the resident's own model.** `agent.model` is the per-resident setting (`PATCH /api/agents/:id/model`, null = the home building's model); the reply turn has read it since the feature landed (0bf5e6a). The facilitator does the same. Only the summary ignores it. So decision (i) below is a statement of fact, not a change.
- **The 12 "errored" facilitation sessions were all `orphaned at restart`** (0 turns each): the server restarted under them. In every case the runtime started a fresh facilitation within about 5 s and that one finished (`done`); all 28 meetings have a notes doc. Seven of the twelve are one restart loop on 2026-10-20 16:35–16:38 UTC. Nothing failed "at the close step"; the notes path was never the problem.

Default facilitator today (`packages/core/src/meetings.ts:34`): for a building meeting, the building's manager if active, else its reviewer, else the first resident by join order; for a town hall, the first active invitee. The notes doc is written by `endMeeting` (`core/meetings.ts:214`) on every path that ends a meeting: the facilitator's `end`, the human's End button (`POST /api/meetings/:id/end`), and the runtime's fallback when the facilitation session returns with the meeting still open (`runtime/meetings.ts:161`). Decisions recorded in the 5-minute grace window after close are appended to the notes (`core/meetings.ts:202`).

## 2. Settled: models

1. **@-reply turns run on the resident's configured model.** Already the code (`runtime/meetings.ts:94`); keep it, and add an assertion to `runtime/test/meetings-chat-scheduler.test.ts` (the reply test at line 114 checks the session but not its model). The facilitator likewise runs on the facilitator's own model.
2. **Summaries move from Haiku to Sonnet.** `runtime/meetings.ts:41` becomes a constant `SUMMARY_MODEL = "claude-sonnet-5-5"`, replacing `building.cheapModel ?? haiku`. `cheapModel` stays what it is for the in-tray "Ask about this" proxy chat (`runtime/chat.ts:18,51`); changing its schema default would not reach the three buildings already in the live DB, which is why the summary gets its own constant rather than a new default. Test change: `meetings-chat-scheduler.test.ts:53` expects `SUMMARY_MODEL` instead of `lab.cheapModel`. Cost: 93 summaries cost $0.06 total on Haiku; on Sonnet this stays in cents per week. `docs/architecture.md` line 130 ("summary session using `cheapModel`") changes with it.

## 3. Settled: what each turn is fed

**3.1 Summaries start from the last meeting ("did" against "said").** The summary prompt gains two blocks, both taken from the previous `done` meeting of the same scope (same `buildingId`, or the previous town hall), found by `meetings.where("buildingId = ? AND phase = 'done'", …, "ORDER BY endedAt DESC LIMIT 1")`:

- *Last time you said:* that attendee's own summary from `meeting.summaries[agentId]` of the previous meeting (two or three lines, already plain language).
- *Decisions assigned to you last time:* each decision of the previous meeting with `assigneeId = agentId`, with its outcome from the linked assignment: `done` plus the report's title and verdict, `active`, `pending`, or `cancelled`. The link exists in the Meeting record (`decisions[].assignmentId`); nothing reads it back today (gap 6 of the background report).

The system prompt's Did line becomes "what I did since the last meeting, against what I said I'd do; say plainly if something I promised didn't happen". Everything else in the prompt stays (last report, events, recent docs). The notes doc need not change: the data comes from the Meeting record, not from parsing the notes. For a first meeting both blocks say "(none; first meeting)".

**3.2 The facilitator gets the building's material; an empty agenda stays allowed.** `facilitatePrompt` gains, after the summaries:

- *In-tray:* the building's pending reports from `intrayOf` (`core/domain.ts:162`): title, author, verdict, the report's "What I need from you" line (the same gist `recentWorkBlock` already extracts). For a town hall: per building, the pending count and the pending rollups and proposals once the waterfall's Town Hall in-tray exists (`docs/waterfall.md` §3.5); until then, each attending manager's building in-tray.
- *Last meeting:* the previous meeting's decisions with their outcomes (same query as 3.1, all assignees), so "we said X, it landed / it didn't" is on the table.
- *Needs:* the "Need:" lines of this meeting's summaries, pulled out as a list (gap 7).

The agenda field keeps its meaning: if the human set one, the facilitator follows it; if it is empty, the prompt says "(none; summarise what's going on from the material below and propose 2–4 items)". Mitchell asked to keep that, and 0 of 28 meetings have set an agenda. The facilitator's first `speak` is still the agenda it chose, so the empty-agenda case is visible in the transcript.

**3.3 @-reply turns get `read` and `search`.** The reply becomes a short host session instead of a one-shot: `runAgentSession` with purpose `meeting-reply`, the resident's model, `maxTurns` 4, `web: false`, and a new `SessionSpec.verbs` allowlist (`["read", "search", "meeting"]`) that narrows `allowedTools` (`runtime/session.ts:148`), so a reply turn cannot `assign`, `submit_report` or `tell`. The runtime still speaks the session's final text into the meeting when the model didn't call `meeting` `speak` itself, so a reply is always posted; the 1,200-character cap and the 5-replies-per-attendee cap stay. The reply system prompt drops "You have no tools in this turn" and says "`read` the doc if someone asks about one; otherwise answer from your context". Cost today: 26 replies cost $0.68 as one-shots; as 2–4-turn sessions expect a few times that, still under the facilitator's cost.

**3.4 The building's manager is the default facilitator.** True today for building meetings (`core/meetings.ts:37`). The change is for town halls: `defaultFacilitator` picks the first active *manager* among the invitees (buildings in creation order) before falling back to the first active invitee, so a reviewer or moderator never ends up facilitating when a manager is in the room. The manager is the right facilitator because it has the context of its own in-tray and the `assign` verb, and under the waterfall it is the only agent Mitchell talks to.

**3.5 The runtime writes the notes doc on every close.** Already true (§1). What is left is the restart case: the redeploy drain waits for live *work* sessions only (`runtime/redeploy.ts:52`), so a redeploy during a discussion orphans the facilitator; the restarted server re-facilitates with a fresh session that sees the transcript but not what the previous facilitator had read. Change: count live `facilitate` sessions in the drain's live set (the drain already has the wrap-up message path, `drainWrapUpMs`, to tell such a session to close the meeting first). A facilitation that is re-run after a restart should also say so in its first `speak` ("picking up after a restart"), which the prompt can do from `meeting.transcript.length > 0`.

## 4. Build order (proposal)

All of §2–§3 is runtime, prompts and one core function; no schema change, no migration. One PR per row keeps each reviewable:

| # | Change | Files | Size |
|---|---|---|---|
| 1 | Summary model Sonnet; reply-model test assertion (done) | `runtime/meetings.ts`, its test, `docs/architecture.md` | tiny |
| 2 | Summaries seeded from the last meeting (3.1); facilitator input (3.2) | `core/prompts.ts`, `runtime/meetings.ts`, a `previousMeeting` helper in `core/meetings.ts` | small |
| 3 | Town-hall facilitator = a manager (3.4) | `core/meetings.ts`, its test | tiny |
| 4 | @-reply as a short session with `read`/`search` (3.3) | `runtime/session.ts` (verb allowlist), `runtime/meetings.ts`, `core/prompts.ts` | small |
| 5 | Drain waits for facilitations (3.5) | `runtime/redeploy.ts`, `runtime/index.ts` | small |

Rows 1–3 fit in the waterfall's step 2 (runtime, Root) or can be done by me; row 2 is what changes the meetings most. Row 4 is independent. Row 5 matters only once redeploys stop happening between meetings.

## 5. Comments on docs for review (a separate system, later)

Mitchell's ask: when he reads a design doc, he wants to comment on it in place, and the author should get the comments and deal with them. This is its own system; nothing above depends on it, and it should come after the manager's 1:1 (waterfall step 4), which is its routing channel.

- **Data.** A `comments` table, one row per comment: `id`, `docId`, `authorId`/`authorKind`, `anchor`, `body`, `state` (`open` | `resolved`), `resolvedBy`/`resolvedAt`, `replyToId` (one level of threading), `createdAt`. The anchor is a text quote with a few words of prefix and suffix (`{quote, prefix, suffix}`), re-found by string match on each render; a quote that no longer matches after an edit shows as "orphaned" at the top of the margin rather than being lost. Comments live outside the doc body, so the body round-trips through the export unchanged; the export can add `comments/` later.
- **API and verbs.** `GET /api/docs/:id/comments`, `POST /api/docs/:id/comments` (anyone who can read the doc can comment), `PATCH /api/docs/:id/comments/:cid` (resolve, reopen, edit own). Agents get one verb, `comments` (list open comments on a doc I can read; resolve one with a note), and `read` returns the open-comment count so an author notices. Events `doc.commented` and `doc.comment_resolved`.
- **Routing to the author.** Open comments on a doc are batched, not delivered one by one. If the author's building has a manager, the batch surfaces to the manager (its team block lists "docs with open comments" and the 1:1 can discuss them) and the manager assigns "Address comments on <doc>" with the doc id; otherwise the runtime creates that assignment for the author directly once the commenter has been quiet for a few minutes. The assignment's session gets the comments inline (quote + body), updates the doc with `write` (same id), and resolves each comment with a one-line note; the report says what changed and what it pushed back on. Under the waterfall's notification rule, Mitchell is not notified for comments he wrote; he sees the resolution in the doc's margin and in the manager's rollup.
- **UI.** In the library doc view: select text, "Comment"; a margin list, open first, with resolve and reopen; a filter to hide resolved ones; the same panel reused by the 1:1's doc links. A comment from a resident on another resident's doc works the same way and is the building-internal review channel.
- **Not in it.** Suggested edits (tracked changes), comments on code, comments on meeting transcripts (the transcript is the comment channel there).

Owner and placement are Pix's call in the waterfall build order; one PR for data + API + `comments` verb, one for the web margin, one for the routing.
