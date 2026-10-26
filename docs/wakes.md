# Wakes: what starts an agent, and one mechanism for all of it

Design note, 2026-10-26 (Keel, as_czxid3dp46; asked by Mitchell in 1:1 mt_pwcpdkmdyc). Not built yet: §4 is the build order.
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
  (`ops.messageAgent`) and the redeploy notice (runtime/index.ts ~445).

Everything else lands in the **inbox** (`sendMessage`). The inbox never wakes anyone (it is seen at the next `look`).

## 1. Inventory

| Event | Who should wake | Wired today | Gap |
|---|---|---|---|
| `assign` (manager, reviewer, human) | assignee | Q (verbs/docs.ts:304 also sends an inbox line) | — |
| Flag, continued or redirected | assignee | Q (domain.ts:230); the flag itself wakes the manager through T | — |
| Report decided: continue or redirect | author / assignee | Q | — |
| Report decided: approve | nobody | — | — |
| Meeting decision with an assignee | assignee | Q (`fromMeeting`, so directed is allowed) | It amends an *active* assignment only by inbox (meetings.ts:253) |
| 1:1 opened, human speaks, 1:1 closed | manager | T (index.ts:261) | — |
| Meeting created or started (invite) | attendees | M: one summary session each; an inbox `meeting` line | — |
| @mention in a meeting, by the facilitator or a human | the mentioned attendee | M (reply session, capped) | — |
| @mention in a doc, `say` or `tell` | mentioned agent | inbox only (mentions.ts:4: "never starts work") | ok for agent→agent; **missing when a human is behind it** |
| `tell`, agent → agent | recipient | inbox only; the sender gets `idleNote` | **missing when a human is behind it** (Mitchell → Pix → Kelly, ms_l8fnqdk15x) |
| Human message to a resident | resident | I if it is working; else Q (a "Message from X" assignment at the front of the queue) | Refused for residents of a building with a manager (ops.ts:400); visitors get it queued |
| `grant.funded` by **fund** | manager | Q: a front-of-queue grant-lane assignment "Grant X funded: assign its first step or take it yourself" with the plan (`Grants.decisionAssignment`, 2026-10-26) | — |
| `grant.funded` by continue or adjust | held grant work | Held grant-lane work is released by the lane gate on the next tick | The manager is not woken; its held step resumes |
| `grant.countered`, `grant.rejected` | manager | Q: a directed assignment ("Answer the counter on X" with the note / "Grant X rejected: read the note"), plus the inbox `system` line (`notifyManager`) | — |
| cut | manager | inbox `system` line only (`notifyManager`) | **missing** |
| `grant.checkpoint` (50% / 100% spent) | manager | Q: a front-of-queue "Write the checkpoint" assignment | — |
| `kr.created` / KR edited by a human | manager | Only `syncBlocked`, which unblocks the building and wakes no one | **missing** |
| Building becomes blocked (goal-directed, no KRs) | manager | Q: a "Get human decisions" assignment (grants.ts:110) | — |
| `waitFor` met (deploy, assignment, decision, after) | the parked assignee | Q: `checkWaits` on the tick clears the wait. After 24 h, T gets a `wait-expired` report | — |
| Redeploy | running agents; parked work | I (notice); Q for `deploy` waits; T resumes the 1:1 (meetings.md §6) | — |
| Exploration allowance reset (UTC midnight) / daily budget reset | held agents | Q: `laneHold` is re-evaluated on every tick; `resetDaily` and `resumeEligible` set agents back to idle | Nothing is announced, but the work resumes |
| A human answers `request_human` | requester | inbox only (ops.ts:560) | Should wake the requester if they parked on it (today the only way is `waitFor decision`) |
| Agent stopped or banned | that agent | `abortWork` (a negative wake) | — |

Two things are missing, and they have the same cause: **an event that a human started does not reach the agent who has
to act on it, unless it happens to create an assignment or an in-tray report.** Both cases are a manager missing
grant and KR events, and a resident missing a relayed human request.

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
("a human asked for it"), which a goal-directed building allows when a human created the work. If the recipient is
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

1. **Origin, recorded only**: the migration, stamping on human acts, inheritance by sessions, copying by tell/assign/mention.
   It shows in the inbox ("for Mitchell, via …") and changes nothing else. About 120 lines plus tests.
2. **Human-origin tells wake** (Mitchell's ask, decision 2): in `tell`, origin + idle resident → a directed "Message from"
   assignment (merged per origin, hop cap); a working recipient gets an interrupt. Replace `idleNote` with the
   result. About 60 lines.
3. **Manager wakes on grant and KR events**: grant decisions done on 2026-10-26 as assignments (Mitchell's ask, 1:1
   mt_f45m8hbmct: `Grants.decisionAssignment`, the same hook as the checkpoint assignment; fund → grant lane, counter /
   reject → directed). Left: cut, and the KR setters (dc_362tfcb7qi §3). `notifyManager` stays as the inbox line.
4. **Waker with a persisted cursor**: move the `onEvent` branches into `WAKE_RULES`, persist `ManageState.offered` as
   `wakeKey`s, replay on boot. No change in behaviour; this is the refactor that makes steps 2–3 rules.
5. **Leftovers, as needed**: `request_human` answered → wake a parked requester; a meeting decision amending an active
   assignment → interrupt (I); then the per-agent subscription table if a use for it shows up.

Steps 2 and 3 fix today's gaps without step 4. Step 4 is worth doing once there is a third or fourth rule to add.
