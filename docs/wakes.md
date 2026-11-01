# Wakes: what starts an agent, and one mechanism for all of it

Design note, 2026-10-26 (Keel, as_czxid3dp46; asked by Mitchell in 1:1 mt_pwcpdkmdyc). §4 is the build order; steps 1, 2, 3 and 5 are built (step 4, the Waker refactor, is in progress).
Code references are to main at 6988a43.

A **wake** is anything that makes an idle agent spend tokens: it starts a session, or it pushes new input into a session
that is already running. Today there are four kinds of wake, each wired separately:

- **Q, the queue.** Something creates a pending assignment. `scheduleWork` (runtime/index.ts ~299) polls every 5 s and starts
  the first one that `Budget.canStart` allows (lane gate `laneHold`, waits, budget, slots). Only the scheduler starts work.
- **T, the in-tray.** `wakeManager` (runtime/manage.ts:48) starts or feeds the manager's manage session when there is an
  unoffered in-tray report or an open 1:1. It runs on `doc.created` (report or flag), on 1:1 meeting events and on every tick.
- **M, meetings.** `meeting.created`/`meeting.phase` start summary and facilitation sessions. An @mention in a live
  meeting by the facilitator or a human starts a reply session (`onMeetingMention`).
- **I, interrupts.** These go to a session that is already running: a human's message to a working agent
  (the old `ops.messageAgent`, removed by 1:1 mt_wql34b8gkl) and the redeploy notice (runtime/index.ts ~445).

Everything else lands in the **inbox** (`sendMessage`). The inbox never wakes anyone (it is seen at the next `look`).

## 1. Inventory

| Event | Who should wake | Wired today | Gap |
|---|---|---|---|
| `assign` (manager, human) | assignee | Q (verbs/docs.ts:304 also sends an inbox line) | — |
| Flag, continued or redirected | assignee | Q (domain.ts:230); the flag itself wakes the manager through T | — |
| Report decided: continue or redirect | author / assignee | Q | — |
| Report decided: approve | nobody | — | — |
| Meeting decision with an assignee | assignee | Q (`fromMeeting`, so directed is allowed) | Amending an *active* assignment: step 5 rule `decision` interrupts the running session, or queues a pending assignment with the decision's lane when none runs |
| 1:1 opened, human speaks, 1:1 closed | manager | T (index.ts:261) | — |
| Meeting created or started (invite) | attendees | M: one summary session each; an inbox `meeting` line | — |
| @mention in a meeting, by the facilitator or a human | the mentioned attendee | M (reply session, capped) | — |
| @mention in a doc, `say` or `tell` | mentioned agent | inbox only without a human origin; with one, step 5 rule `mention` queues a directed assignment for an idle resident | — |
| `tell`, agent → agent | recipient | inbox only without a human origin (the sender gets `idleNote`); with one, step 2 `relayWake` | — |
| Human message to a resident (removed: 1:1 mt_wql34b8gkl; humans use 1:1s) | resident | I if it is working; else Q (a "Message from X" assignment at the front of the queue) | Refused for residents of a building with a manager (ops.ts:400), on purpose: the manager is the building's conversational surface. Visitors get it queued |
| `grant.funded` by **fund** | manager | Q: a front-of-queue grant-lane assignment "Grant X funded: assign its first step or take it yourself" with the plan (`Grants.decisionAssignment`, 2026-10-26) | — |
| `grant.funded` by continue or adjust | manager; held grant work | T: a town-written in-tray row "Grant X continued/adjusted: N tokens" (`managerIntrayRow`, core/src/wakes.ts); held grant-lane work is released by the lane gate on the next tick | — |
| `grant.countered`, `grant.rejected` | manager | Q: a directed assignment ("Answer the counter on X" with the note / "Grant X rejected: read the note"), plus the inbox `system` line (`notifyManager`) | — |
| cut, or a human closes a grant | manager | T: a town-written in-tray row "Grant X cut" (`managerIntrayRow`), plus the inbox `system` line (`notifyManager`) | — |
| `grant.checkpoint` (100% spent) | manager | Q: a front-of-queue "Write the checkpoint" assignment | — |
| `kr.created` / `kr.updated` / `kr.deleted` by a human | manager | T: a town-written in-tray row "Key result X written/edited/marked S/moved/removed by Mitchell" (`managerIntrayRow`; a goal-tree move says moved, not "marked" with the unchanged status); `syncBlocked` as before. The manager's own KR writes and status marks write none; re-marking the current status with no new note is a no-op (no event) | — |
| Lab becomes blocked (no KRs, no funded grant) | manager | Q: a "Get human decisions" assignment (grants.ts:110) | — |
| `waitFor` met (deploy, assignment, decision, pr, after) | the parked assignee | Q: `checkWaits` on the tick clears the wait. A `{pr: N}` wait holds until the PR's CI finished (passed or failed) or the PR is merged or closed; a PR that conflicts with its base gets no CI run, so it reads as failed ("merge conflict: CI did not run"): the runtime reads it from GitHub about once a minute (runtime `pr-checks.ts`), so a fork waiting on CI parks on `{pr}`, never on an `{after}` guess (Mitchell, 1:1 mt_3jtclcoxl2). An assignment wait follows the awaited work's park continuations (`chainTip`): a parked report does not release it, only the chain ending done or cancelled. After 24 h, T gets a `wait-expired` report | — |
| Redeploy | running agents; parked work | I (notice); Q for `deploy` waits; T resumes the 1:1 (meetings.md §6) | — |
| Exploration allowance reset (UTC midnight) / daily budget reset | held agents | Q: `laneHold` is re-evaluated on every tick; `resetDaily` and `resumeEligible` set agents back to idle | Nothing is announced, but the work resumes |
| A human answers `request_human` | requester | step 5 rule `request-answer`: an interrupt if the requester is working, else a pending directed assignment | — |
| Agent stopped or banned | that agent | `abortWork` (a negative wake) | — |

Two things are missing, and they have the same cause: **an event that a human started does not reach the agent who has
to act on it, unless it happens to create an assignment or an in-tray report.** Both cases are a manager missing
grant and KR events (fixed by step 3, 2026-10-26), and a resident missing a relayed human request.

## 2. Proposal: one waker over the event log

**The stream.** The event log (`events`, append-only, id-ordered, GET /api/events?since=) is the pub/sub stream; nothing
new is needed on the publish side. The runtime's `onEvent` (index.ts:254) already subscribes to it, but the subscription
is in memory: events that arrive during a restart are lost, and the tick sweeps (`wakeManagers()`, `checkWaits`,
`scheduleWork`) make up for that. Replace it with a **Waker** that keeps a **persisted cursor** (the last event id it
handled, in a `town_state` row). On boot it reads `events.list({since: cursor})`, after that it handles live events, and
it advances the cursor after each handled batch.

**Subscriptions are rules, not rows.** A table in code, `WAKE_RULES: { type, match(e, world) → Wake[] }`. A `Wake`
names an agent and one of the four kinds above. Default subscriptions follow from role:

- **resident**: assignments to me (Q); meetings I attend (M); a tell or @mention to me *with a human origin* (Q, see below).
- **manager**: everything for a resident, plus my building's in-tray, 1:1s, `grant.*`, `kr.created`/`kr.updated` by a human,
  `building.blocked` (T).
- **visitor**: nothing starts work (an assignment is an offer); messages wait in the mailbox, as today.

A per-agent `subscriptions` table (for example "wake me when doc X changes") is possible later. Nothing needs it now.

**The rule that keeps it safe: a wake writes state, it never starts a session.** A rule produces a durable item that the
existing starters already handle:

- a pending assignment, which the scheduler and lane gate start, or
- a town-written in-tray report, which `wakeManager` coalesces into one manage session (Kelly's design, dc_362tfcb7qi).

Every item carries `wakeKey = rule:eventId:agentId` (unique). A replayed event or a double delivery is then a no-op. The
tick sweeps stay as the level-triggered safety net. Budget, lane, slot and drain checks stay in the one place they are
now (`canStart`, `ManageGate`).

**Human origin.** Add `origin: { userId, via: meetingId | messageId | docId, hops, at } | null` to Message,
Assignment and Session. It is stamped and passed on by the town, never claimed by an agent:

1. **Stamped** when a human acts: a human's message, a 1:1 utterance, a decision in a meeting where a human spoke, a
   human's `assign` / flag / review.
2. **Inherited by sessions**: a work session takes its assignment's `origin`. A manage session fed by a 1:1 takes the
   origin of the human's latest line.
3. **Passed on** by `tell`, `assign` and @mentions: the town copies the acting session's origin with `hops + 1`, so a relay
   such as Mitchell → Pix → Kelly keeps "for Mitchell, via mt_pwcpdkmdyc".

The rule for Mitchell's case: **a `tell` (or @mention) with an origin, sent to an idle resident, becomes a directed
assignment** ("Message from Pix for Mitchell: …", at the front of the queue). It is appended to that recipient's pending
message assignment for the same origin, in the same way `messageAgent` merges follow-ups today. The lane is `directed`
("a human asked for it"), which every lab allows when a human created the work. If the recipient is
working, the message is delivered as an interrupt (I). Without an origin, a tell stays inbox-only, as today.

## 3. What changes, migration, risks

**Core.** A migration for the `origin` columns (messages, assignments, sessions) plus `town_state.wakeCursor`.
`createAssignment` and `sendMessage` accept `origin`. `verbs/social.tell`, `verbs/docs.assign` and `notifyMentions` read
the acting session's origin. `Grants.decide` and the KR setters stop calling `notifyManager` and leave it to the rules.
`resolveLane` treats an assignment with an origin as human-created, so it is directed.

**Runtime.** A new `waker.ts` takes over the branches of `onEvent`: meeting starts, mention replies, 1:1, in-tray,
stop/ban. `ManageState.offered` (in memory: "a restart offers the in-tray again") becomes the in-tray items' `wakeKey`s.

**Migration.** Move the existing branches into rules first, with no change in behaviour and the existing tests as the
oracle. Then add the new rules one at a time. The ad-hoc creators (`blockedAssignment`, the checkpoint assignment,
`wait-expired`, the "Message from" assignment) can stay where they are, because they already write state. Each can
become a rule later if it is touched anyway.

**Risks.**
- *Loops.* Agent → agent tells without an origin never wake anyone, as today. An origin carries `hops` (cap 3) and expires
  24 h after the human acted. A recipient gets at most one pending message assignment per origin (merged). The
  meeting-reply cap (`MEETING_REPLIES_MAX`) stays.
- *Double wakes.* `wakeKey` uniqueness, together with the cursor that only advances after state is written, makes replays
  idempotent. The level-triggered sweeps never create items: they only start what exists.
- *Allowance.* Wakes never bypass `canStart`. Human-origin work is directed, so it doesn't spend the exploration allowance,
  but it does spend the building's budget. Manager wakes on grant and KR events are in-tray rows, so a burst of ten
  decisions becomes one manage session, not ten.
- *Cost.* Each manager wake is one manage session of roughly 100–300k tokens. A human relay is one directed session. Both
  are things a human asked for. The waker itself is one indexed query (`id > cursor`) per tick.
- *Forged origin.* `origin` is never a verb input, so an agent can't put "Mitchell asked" on its own tell. It only carries
  an origin that the town gave its session.
- *Hooks vs. subscribers.* `addHook` runs inside the appending transaction. The waker must be a subscriber with the
  cursor, so it doesn't run against uncommitted state.

## 4. Build order (each step: tests, docs, main)

1. **Origin, recorded only** — done 2026-10-27 (migration 041, core/src/origin.ts). `origin {userId, via, hops, at}` on
   messages, assignments and sessions (JSON columns). Stamped (hops 0): a human's tell (a human's
   avatar's `tell`, via the message id), an assignment a human creates (`createdBy` a user: assign, review, decisions;
   via its meeting or report), work from a human-written doc (a flag; via the doc), a decision in a meeting a human took
   part in (via the meeting: the 1:1's human, else the last human who spoke). A session takes its assignment's origin,
   else its meeting's (a 1:1 manage session, a mention reply). `tell`, `assign` and @mentions copy the acting
   session's origin (the agent's latest running session) with `hops + 1`; a continuation inherits the assignment it
   continues. Shown in `agent.told`, `assignment.created`, `session.started` and `agent.mentioned` payloads and in the
   inbox (`for`, `origin`). Not a verb input. Changes nothing else. Tests: core test/origin.test.ts.
2. **Human-origin tells wake** — done 2026-10-27 (`relayWake`, core/src/wakes.ts, called from the `tell` verb). A tell
   whose `origin` is at most 3 hops and 24 h from the human, sent to an idle (or out-of-budget) resident with no work
   session running, queues a pending directed "Message from <human> (via <sender>): …" assignment at the front of the
   queue (sourceId = `origin.via`, origin copied). Later tells for the same human and path merge into it while it is
   pending. The description carries `wake:relay:<eventId>:<agentId>`, so a replay is a no-op. A busy recipient, a tell
   with no origin, or one past the caps stays inbox only (`idleNote`). `canStart` stays the gate. No migration. A
   human's REST tell (the removed `messageAgent`, hop 0) used to do this. Tests: core test/wakes-relay.test.ts.
3. **Manager wakes on grant and KR events** — done 2026-10-26. Grant decisions as assignments (Mitchell's ask, 1:1
   mt_f45m8hbmct: `Grants.decisionAssignment`, the same hook as the checkpoint assignment; fund → grant lane, counter /
   reject → directed). The rest (continue, adjust, cut or close by a human, and a human's `kr.created` / `kr.updated` /
   `kr.deleted`) write one town-authored in-tray row (`managerIntrayRow`, core/src/wakes.ts; author `system`, shown as
   Town; tag `wake:manager-intray:<eventId>:<buildingId>` so a replay writes nothing), now the Waker's
   `manager-intray-row` rule (step 4); the row's `doc.created` wakes the manager through T like a resident's report, and it acknowledges it with
   `review` approve. Grant events carry `payload.action` (the history entry) so the rule can tell fund from continue.
   `notifyManager` stays as the inbox line.
4. **Waker with a persisted cursor** — done 2026-10-27 (runtime/src/waker.ts). The runtime's `onEvent` branches are
   now `WAKE_RULES`, a table in code (name, whose wake, kind M/T/Q/stop, first match wins in the old branch order):
   meeting summaries, facilitation, meeting reply, the manager's 1:1, the manager's in-tray (T), step 3's
   `manager-intray-row`, and stop. `startWaker` subscribes to the event log and keeps a cursor (the last event id
   handled) in `meta` key `wakeCursor` (`TownMeta.wakeCursor`; no migration). On boot it replays `(cursor, lastId]`
   for the durable rules only (`replay: true`, today just `manager-intray-row`, which writes under its wakeKey, so a
   replay or a double delivery writes nothing); a first boot starts at the end of the log. The cursor only passes an
   event once its durable rule has settled. Kick rules (start or feed a session through the runtime's starters) are
   not replayed: the tick's level-triggered sweeps (`wakeManagers`, `scheduleMeetings`, `scheduleWork`) cover a
   restart, as before. Stayed ad hoc: step 2's `relayWake`, called by the `tell` verb itself, because the tell's
   reply must say whether it woke the recipient and "idle, no session running" must be judged at tell time, not at a
   later replay; and `ManageState.offered`, kept in memory, because persisting it would change what a restarted
   manager is offered (no change in behaviour was the rule). Tests: runtime test/waker.test.ts.
5. **Leftovers** — done 2026-10-27, c59b606 (core/src/wakes.ts; tests core test/wakes-step5.test.ts). Three rules, each called
   where its event is appended (like step 2's `relayWake`, and for the same reason: "is the agent working or idle" is
   judged at that moment, so they stay out of the Waker's replay). Each writes one item keyed
   `wake:<rule>:<eventId>:<agentId>` (in the assignment description or the interrupt text), so a second delivery writes
   nothing; none starts a session (`canStart` stays the gate).
   - `request-answer` (`requestAnswerWake`, from `requestAction` done): the requester's running work session gets the
     answer as an interrupt (in-process, else queued for the desk, as a human's message); an idle or out-of-budget
     resident gets a pending directed "Answer to your request <title>: <first line>" at the front (sourceId = the
     human-report, origin = the answering human). The inbox line stays.
   - `decision` (`decisionWakes`, from `meetingDecide`): a decision that supersedes one whose assignment is *active* for
     the same assignee interrupts the running session with the decision text; if no session runs and the agent is
     idle, a pending "Amended in meeting: …" assignment with the decision's lane fields (else the amended assignment's).
   - `mention` (`mentionWake`, from `notifyMentions`): an @mention whose origin is at most 3 hops and 24 h from the
     human (a human's own @mention is hop 0), to an idle resident with no work session, queues a pending directed
     "Mentioned by <author> [for <human>]: …" at the front; repeats for the same human and path merge into it. No
     origin, past the caps, a busy target, or a mention inside a live meeting the target attends (M covers it) stay
     inbox only.
   Not done: the per-agent subscription table (no use for it yet). The one remaining "gap" in §1, a human messaging a
   resident of a managed building, is refused on purpose.

Steps 2 and 3 fix today's gaps without step 4. Step 4 is worth doing once there is a third or fourth rule to add.
