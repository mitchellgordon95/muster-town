# Meetings: the changes agreed at the 2026-10-24 town hall

Status: **design note, settled unless marked "proposal"** (town hall `mt_zyy96z8fgt`, decision 5; notes in the library). Author: Kelly. Town copy: dc_2i93rukmeq. Written from main at d6111c6. Background: [How meetings happen today](dc_q9pmstkli1) (all 28 live meetings, the code paths, the 9 gaps). The waterfall note (`docs/waterfall.md`, dc_g9d74v8kdb) owns rollups, the Town Hall in-tray and the manager's 1:1; this note owns only the meeting machinery and, in §5, comments on docs.

## 1. What is true today (verified in code)

| Turn | Model | Tools | Input | Where |
|---|---|---|---|---|
| Attendee summary | `SUMMARY_MODEL` = `claude-sonnet-5-5` (was `building.cheapModel`, Haiku, until row 1 landed) | none (one-shot) | own last report, own last 20 events, own 3 recent docs; agenda or "(none)" | `packages/runtime/src/meetings.ts:41`, `packages/core/src/prompts.ts:158` |
| Facilitator | `facilitator.model ?? meeting building's model ?? home building's model ?? claude-opus-5-5` | every town verb (`look`, `read`, `search`, `meeting`, `assign`…), no web, no code; ≤60 turns | summaries, last 20 utterances, agenda or "(none; set one from the summaries)" | `runtime/meetings.ts:151`, `prompts.ts:173` |
| @-reply | `agent.model ?? home building's model ?? claude-opus-5-5` | `read`, `search`, `meeting` only (`MEETING_REPLY_VERBS`; host session, ≤4 turns, no web; was a one-shot until row 4 landed) | last 20 utterances, own assignment, last report, 20 events, 3 recent docs | `runtime/meetings.ts:107`, `prompts.ts:294`, `runtime/session.ts:61` (`SessionSpec.verbs`) |

Two corrections to what was said in the meeting (I said it, so I'm correcting it):

- **@-reply turns already use the resident's own model.** `agent.model` is the per-resident setting (`PATCH /api/agents/:id/model`, null = the home building's model); the reply turn has read it since the feature landed (0bf5e6a). The facilitator does the same. Only the summary ignores it. So decision (i) below is a statement of fact, not a change.
- **The 12 "errored" facilitation sessions were all `orphaned at restart`** (0 turns each): the server restarted under them. In every case the runtime started a fresh facilitation within about 5 s and that one finished (`done`); all 28 meetings have a notes doc. Seven of the twelve are one restart loop on 2026-10-20 16:35–16:38 UTC. Nothing failed "at the close step"; the notes path was never the problem.

Default facilitator today (`packages/core/src/meetings.ts:36`): for a building meeting, the building's manager if active, else its reviewer, else the first resident by join order; for a town hall, the first active manager among the invitees (buildings in creation order), else the first active invitee (was the first active invitee until row 3 landed). The notes doc is written by `endMeeting` (`core/meetings.ts:214`) on every path that ends a meeting: the facilitator's `end`, the human's End button (`POST /api/meetings/:id/end`), and the runtime's fallback when the facilitation session returns with the meeting still open (`runtime/meetings.ts:161`). Decisions recorded in the 5-minute grace window after close are appended to the notes (`core/meetings.ts:202`).

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

**3.5 The runtime writes the notes doc on every close.** Already true (§1). What is left is the restart case: the redeploy drain waits for live *work* sessions only (`runtime/redeploy.ts:52`), so a redeploy during a discussion orphans the facilitator; the restarted server re-facilitates with a fresh session that sees the transcript but not what the previous facilitator had read. Change: count live `facilitate` sessions in the drain's live set (the drain already has the wrap-up message path, `drainWrapUpMs`, to tell such a session to close the meeting first). A facilitation that is re-run after a restart should also say so in its first `speak` ("picking up after a restart"), which the prompt can do from `meeting.transcript.length > 0`. (Amended 2026-10-25, §6: the drain now waits on a facilitation for 2 min only, then posts a notice, restarts and resumes.)

## 4. Build order (closed 2026-10-25: every row live on muster.town)

All of §2–§3 is runtime, prompts and one core function; no schema change, no migration. One PR per row keeps each reviewable:

| # | Change | Files | Size |
|---|---|---|---|
| 1 | Summary model Sonnet; reply-model test assertion (done) | `runtime/meetings.ts`, its test, `docs/architecture.md` | tiny |
| 2 | Summaries seeded from the last meeting (3.1); facilitator input (3.2); town-hall opener "Decisions needed from the humans" (mt_p8mo4bsrsy decision 5) (done) | `core/prompts.ts`, `runtime/meetings.ts`, a `previousMeeting` helper in `core/meetings.ts` | small |
| 3 | Town-hall facilitator = a manager (3.4) (done) | `core/meetings.ts`, its test | tiny |
| 4 | @-reply as a short session with `read`/`search` (3.3) (done) | `runtime/session.ts` (verb allowlist), `runtime/meetings.ts`, `core/prompts.ts` | small |
| 5 | Drain waits for facilitations (3.5) (done) | `runtime/redeploy.ts`, `runtime/index.ts` | small |

Closed 2026-10-25 04:28 UTC: `GET https://muster.town/api/health` read 9aa87fa, which contains the last merge of this order, fae5737 (PR #48; rows 1–2 went live as de4474b, verified on 867dc3f). Still to observe, not yet possible: no meeting has been called since fae5737 merged, so no `meeting-reply` session has run live. The check, at the first @-mention in the next meeting: the mentioned resident's `session.started` event (`GET /api/agents/:id`, `recentEvents`) carries `payload.purpose = "meeting-reply"`, its session row has `maxTurns` 4 and the reply reads docs before speaking; and its cost against the one-shot baseline (26 replies for $0.68 across the 28 meetings before row 4).

## 5. Comments on docs for review (a separate system, later)

Mitchell's ask: when he reads a design doc, he wants to comment on it in place, and the author should get the comments and deal with them. This is its own system; nothing above depends on it, and it should come after the manager's 1:1 (waterfall step 4), which is its routing channel.

- **Data.** A `comments` table, one row per comment: `id`, `docId`, `authorId`/`authorKind`, `anchor`, `body`, `state` (`open` | `resolved`), `resolvedBy`/`resolvedAt`, `replyToId` (one level of threading), `createdAt`. The anchor is a text quote with a few words of prefix and suffix (`{quote, prefix, suffix}`), re-found by string match on each render; a quote that no longer matches after an edit shows as "orphaned" at the top of the margin rather than being lost. Comments live outside the doc body, so the body round-trips through the export unchanged; the export can add `comments/` later.
- **API and verbs.** `GET /api/docs/:id/comments`, `POST /api/docs/:id/comments` (anyone who can read the doc can comment), `PATCH /api/docs/:id/comments/:cid` (resolve, reopen, edit own). Agents get one verb, `comments` (list open comments on a doc I can read; resolve one with a note), and `read` returns the open-comment count so an author notices. Events `doc.commented` and `doc.comment_resolved`.
- **Routing to the author.** Open comments on a doc are batched, not delivered one by one. If the author's building has a manager, the batch surfaces to the manager (its team block lists "docs with open comments" and the 1:1 can discuss them) and the manager assigns "Address comments on <doc>" with the doc id; otherwise the runtime creates that assignment for the author directly once the commenter has been quiet for a few minutes. The assignment's session gets the comments inline (quote + body), updates the doc with `write` (same id), and resolves each comment with a one-line note; the report says what changed and what it pushed back on. Under the waterfall's notification rule, Mitchell is not notified for comments he wrote; he sees the resolution in the doc's margin and in the manager's rollup.
- **UI.** In the library doc view: select text, "Comment"; a margin list, open first, with resolve and reopen; a filter to hide resolved ones; the same panel reused by the 1:1's doc links. A comment from a resident on another resident's doc works the same way and is the building-internal review channel.
- **Not in it.** Suggested edits (tracked changes), comments on code, comments on meeting transcripts (the transcript is the comment channel there).

Owner and placement are Pix's call in the waterfall build order; one PR for data + API + `comments` verb, one for the web margin, one for the routing.

## 6. Meetings and redeploys: post the notice, restart, resume (settled 2026-10-25)

What went wrong (1:1 mt_yrr8hvez2f, 16:48–16:52 UTC): a redeploy started draining while Mitchell talked to Pix. The drain closed Pix's 1:1 session at once (`manage.ts` let a session held open only by a 1:1 go) and then waited 7 minutes on another resident's work session. Mitchell's next two lines ("to be clear, …", "hello?") reached nobody, nothing in the meeting said why, and he ended the 1:1 before the restart.

Policy: a redeploy never waits indefinitely on a meeting, and a meeting never goes silent without saying why.
- **The drain waits on a meeting session only briefly.** Facilitations and the manager's session while one of its 1:1s is open count in the drain for `drainMeetingMs` (2 min), then the drain stops waiting for them (event "Redeploy: not waiting longer for meeting session(s): …"). Work sessions keep the full 30-minute drain. This replaces §3.5's "the drain waits for facilitations".
- **Nudges.** A facilitator is told to decide and close a meeting no human is in, and to carry on if a human is talking. The 1:1 manager is told to keep answering (not the work-session "submit and stop" text).
- **While draining, the 1:1 keeps working.** The manager's session is no longer closed; the human's lines are still streamed in, and a 1:1 opened (or a manager woken) during the drain still starts a session. New in-tray reports wait for the new server.
- **The notice.** Just before the exit, every discussing meeting gets a system line (speakerId `system`, speakerKind `system`, shown as "Town"): "Pix's reply is waiting on a redeploy (commit abc1234); the server is restarting and the meeting resumes after the restart." It reaches the human in the panel and a facilitator through `listen`.
- **Resume.** Nothing is lost: the transcript is in the world. After the restart the first tick wakes the manager for every open 1:1 (`wakeManager`, the same path as opening one); `oneOnOnePrompt` lists the human's lines after the manager's last reply as unanswered and asks it to answer them now without greeting again. A standup is re-facilitated from its transcript ("picking up after a restart", §3.5).
- **A busy agent says so** (1:1 `mt_v79lzn92wk`, 2026-10-31: Mitchell's "hellooooooo" to Nell got no answer and no word while her desk work session ran). An agent in a work session can't take a 1:1 until it ends (`wakeTalker` only feeds a manage session). The town posts once per busy session "<agent> is in a work session ("<assignment>") and answers here when it ends." (`noticeBusy`); the quiet close skips a 1:1 whose human line waits on that agent, and the tick runs it after `wakeManager`, so the answering session starts first and the quiet clock restarts from its start.
- **Code.** `runtime/redeploy.ts` (`inMeeting`, `drainMeetingMs`, `beforeRestart`), `runtime/index.ts` (`inMeetingSession`, `postRestartNotices`), `runtime/manage.ts`, `core/meetings.ts` (`meetingNotice`), `core/prompts.ts` (`oneOnOnePrompt`). Tests: `runtime/test/one-on-one.test.ts`, `runtime/test/stale-state.test.ts`, `core/test/one-on-one.test.ts`.


## 7. "is writing…" for agents (town hall mt_q1w4o85ao9 decision 5 item 1)

The meeting panel shows "<name> is writing…" under the transcript while an agent drafts, so a human doesn't read a slow reply (or the facilitator writing decisions) as a stall. It is a heuristic kept in memory on the server (`noteAgentDrafting` / `agentsDrafting` in packages/core/src/meetings.ts), not a column:

- **Set** during the discussion when an agent's `listen` returns something from someone else, and for the facilitator after any `listen` or `status` (it is steering or writing decisions).
- **Cleared** when that agent calls `listen` again (waiting to hear is not writing), speaks, decides or ends; when its session ends; when the meeting leaves collecting/discussing; or after `AGENT_DRAFTING_MS` (5 min).
- Read by `GET /api/meetings/:id/drafting` → `{drafting: [{id, name}]}`, which the panel polls every 4 s while the meeting is live; agents see the same names as `drafting` in `meeting` action "status". A restart drops every mark.

## 8. Presenting in a meeting (town hall mt_q1w4o85ao9 decision 5 item 3)

A speaker can put something on the table with a line: `meeting {action: "speak", text, attach}` (agents) or
`POST /api/meetings/:id/say {text, attach}` (humans). `attach` is one of:

| attach | kind | shown in the meeting panel |
| --- | --- | --- |
| a doc id `dc_…` (not a draft) | doc | a card: title and the body's opening 400 characters, opening the doc |
| an uploaded image or video: `mf_…` or its `/api/media/…` url (`POST /api/media`, docs/multimedia.md) | media | the image (or video) inline |
| a grant `gr_…`, an agent `ag_…`, `building:<id>`, `bank`, `finance` (the Bank page too: the Finance page is part of it), `dashboard`, `connect`, `manual` or `manual/<section>` | page | a card that opens that panel |

core `resolveAttachment` (core/meetings.ts) checks it and stores `{kind, ref, title, excerpt?, url?}` on the utterance
(`MeetingUtterance.attachment`, inside the meetings.transcript JSON column, so no migration); the doc's title and
opening are kept as said. A bad attach refuses the whole line. `speak` returns `presented`; `listen` and `status`
give each utterance's `presented` line (markdown); the notes doc keeps it after the line as `(presented: …)`, so the
reference survives the meeting. The web shows it under the bubble (MeetingPanel `Presented`).

## 9. One "Call a meeting" form, presets (gr_jh0lu0w6yj step 2; Lena's design dc_tcoy1plt2r)

One form (web `panels/CallMeetingForm.tsx`) in the meeting room (open in an empty room, folded under a finished meeting as "Call another meeting"). The room is the only entry point (the building panel has no Meetings tab since Mitchell's 1:1 mt_auczm6f1j1): click the table on the map, walk up and press E, or Overview → "Walk to the meeting table"; it lists the building's meetings, upcoming then past, and shows the live one with the rest folded under it. A link into the old tab opens the room (web `panels/room.ts` `redirectPanel`). The 1:1 stays its own "Talk to ★" button.

- **Preset** (`MEETING_PRESETS` in schema, shared by web and tests): Standup, Town hall, Review the in-tray, Retro, Planning, Blank. It pre-fills the fields below and is stored only as `kind` (labels; `in-tray-review` and `ad-hoc` are new). Every field stays editable.
- **Agenda**: items, stored as numbered lines in `Meeting.agenda` (core `agendaText`). The facilitator is told "Cover these, in order, before your own items"; empty = it proposes 2-4.
- **What each attendee brings** (`Meeting.brings`, migration 052): `status` = the Did/Next/Need summary; `nothing` = no collecting round (core goes straight to `discussing` on startNow; runtime `onMeetingStart` does it for a scheduled one); `custom` = the human's line replaces the Did/Next/Need instructions in the summary system prompt and the invite.
- **Ask the humans for decisions** (`Meeting.askHumans`, migration 052; default = kind is town-hall, and existing town halls were set to 1): the "Decisions needed from the humans" opener now follows this flag, not the kind.
- The meeting panel shows the agenda line by line and "Attendees bring: …"; the notes header says what attendees brought and whether it opened with the humans' decisions.
- Tests: core `test/meeting-form.test.ts`, runtime `meetings-chat-scheduler.test.ts` (nothing skips summaries; custom reaches the summary prompt).

## 10. Presentation with chat (gr_jh0lu0w6yj step 5; design dc_y7a8g257of §1 presenter view, §3)

A meeting can present a deck above its chat: a deck doc (type `deck`) or the review deck (the literal id `review-deck`, `REVIEW_DECK_ID`; computed from the in-tray, not stored).

- **State**: `Meeting.deck = {docId, slide, presenterId}` (JSON column, migration 054; null = a chat meeting). The meeting row changes on every move, so every open meeting panel follows the slide over the existing websocket `meeting` updates.
- **Mode in the Call-a-meeting form**: Chat | Presentation with chat (the review deck, or a deck doc by id), sent as `CreateMeetingInput.deck {docId}`; the meeting starts on slide 1 with whoever called it as presenter. The "Review the in-tray" preset (`MEETING_PRESETS[].deck`) pre-fills the review deck, nothing to bring, decisions opener on.
- **Present**: `POST /api/meetings/:id/present {docId|null, slide}` (core `presentSlide`; the facilitator, anyone with meeting.facilitate, or any signed-in human; only while collecting or discussing). The web shows "Present in <meeting>" on a deck doc (DeckView) and on Review as deck while a meeting is live; it opens the meeting. `docId` null stops presenting.
- **Transcript lines**: each move posts a system line "— slide n: <slide title>" (a new deck first posts "— <name> is presenting "<title>" (N slides)"); the same slide twice posts nothing. Event `meeting.slide`. The notes keep the lines, so each remark sits under its slide.
- **Pinned review deck** (Mitchell, mt_xywhisvdcm): when a meeting with the review deck goes live, and on every move, `Meeting.deck.pinned` stores the slide list (key, kind, title, text, item ids; no migration, the column is JSON). The meeting's deck (`GET /api/review-deck?meeting=<id>`, core `presentedReviewDeck`) keeps that order: a slide whose item left the in-tray stays at its number with `decided` ("cut", "funded", "approved", "key result marked met"…) and no buttons; new in-tray items append at the end. The presenter moves on by hand.
- **Presenter view**: web `panels/MeetingSlide.tsx` shows the slide in a modal centred over the map, and the chat stays in the side panel (Mitchell, mt_xywhisvdcm); the panel carries a "Presenting: … · slide n of N · Hide/Show slides" line. At ≤760px, where the panel is the whole width, the slide stays above the transcript. ← → (with focus) or the arrows move it for everyone. Only the presenter (`presenterId`, the last to move it) sees the Notes line and the next slide's title.
- **Facilitator**: `facilitateMaterial` opens with "Presenting: …, slide n of N" and the slide's whole text and notes; `meeting` status and listen return `slide {deck, n, of, title, text, notes?}`.
- **Decisions from a slide**: on the review deck the slide carries its in-tray buttons (GrantRow, Talk to + Archive, Approve all). They send `deckSlide` and `meetingId`; the grant decide and archive routes then also record a meeting decision "<name> funded gr_… "<objective>" (on slide n)" (core `recordSlideDecision`, event `meeting.decisions` with payload.deckSlide), besides the in-tray event's payload.deckSlide.
- Tests: core `test/presentation.test.ts`, server `test/review-deck.test.ts` (present route, decision with meetingId), web `test/meetingSlide.test.tsx`.
