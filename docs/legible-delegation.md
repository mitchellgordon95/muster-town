# Legible Delegation

Status: **vision and build plan, 2026-11-08; steps 1-8 of §11 built on the legible-delegation branch on 2026-11-09, steps 9-10 and the UI items in progress.** §2 names what the town had before and, under "Built on 2026-11-09", where the new code is; §11 marks each built step with its commits. Written from Mitchell's session with Claude on 2026-11-08, which read the 24 items then waiting in the Town Hall in-tray, pulled every grant checkpoint and 663 grant-lane sessions from prod, read 13 session transcripts, and worked out why the in-tray felt like drudgery and why grants hold when they do. For the Town Workshop and UI / UX buildings first: §11 is their build order. It sits beside `docs/how-work-gets-done.md` (how work is steered) and `docs/design.md` (the public town); where it changes how a rollup, a checkpoint or the in-tray works, this doc wins and the older section gets a pointer.

Three voices, kept apart, as in the other vision docs:

- **Mitchell said**: his words, quoted, from the 2026-11-08 session unless a meeting id is given.
- **Proposed**: what this doc says the town should do.
- **Open**: what nobody has decided yet. §12 lists what needs Mitchell.

## 1. The problem

The town's whole design routes every consequential step through a human: reports are the human interface, a grant is funded by a person, nothing continues without a decision. That is deliberate and it stays. The problem is what the human is handed to decide with.

**Mitchell said:** "i'm feeling like i'm the bottleneck to progress. it doesn't feel like the right answer is for me to get out of the way, either." And on what happens when he does open an item: "either there's nothing for me to decide and i just archive it, or there's questions for me but i'm so far out of context that i hit the 1:1 button … and finally get to a decision of either 'that's not important don't ask me' or 'oh obviously you should X' or 'let's take a step back and think of the architecture as a whole'."

The 24 items in the in-tray on 2026-11-08 (10 rollups, 10 grant proposals, 3 checkpoints, 1 retainer) sorted like this:

| What the item actually wanted | Count | Examples |
|---|---|---|
| The human's hands, not their judgment | 6 | accept a captain ask, create a GitHub repo for the test account, reissue its PAT, run a 25-minute Fly drill, provide a Linux box, hold a 1:1 |
| Money the manager already recommends saying yes to | 13 | 10 proposals totalling 2.53M of a 17.9M Bank; 3 checkpoints each "one cheap step left, continue" |
| Bookkeeping | 5 | "flip this key result to missed if you want the literal reading"; one key result already met |
| A rule the manager applied, offered for veto | 4 | "unless you'd rather a plain member could 1:1 a manager"; "say if you want origin-less tells to leave a row" |
| Already overtaken | 2 | a Let-in click made two days earlier; a veto window on a step that had since shipped |

Not one of the 24 held a decision the reader could make from the item alone. The same ask appeared in up to four places (two rollups, a card, the digest). The four rule vetoes, the only lines where Mitchell's opinion changes what the town does, sat mid-report in four different rollups. Each rollup cost 70-90k tokens and ran to 900 words, of which 15-30 lines were "dc_… → approved": audit trail, not steering.

Three lessons, in the words of the session:

1. The expensive part of an item is not the question, it is **rebuilding the reader's context**. The project felt fine at the start because the context was resident in Mitchell's head; now the decisions have gotten smaller and the reload cost bigger, and that ratio is the drudgery.
2. "Don't ask me" means the escalation threshold is miscalibrated. "Obviously X" means a principle is missing from the written rules. Only "let's step back" is real decision work, and it almost never arises from a single item.
3. The rollup is a good **record** and a poor **decision instrument**. Those are two artifacts, and today one document tries to be both.

Karpathy's 2026-10 tip (ask a model for ASD-STE100, the aircraft-maintenance controlled English, "80% of the way" because the spec is stringent) gives the second half of the answer: AI output is an interface, and it should be designed for the cognitive task the reader has to perform. "Fluency is not the same as reviewability." A rollup is descriptive text; an ask is procedural text, an instruction to a human. STE was built for exactly the latter, and the one test anyone ran on coverage found strict STE dropped 40-47% of the facts in descriptive explanations. So: controlled language for asks, never for records.

The name for the area, since none of the fields it borrows from (supervisory control, management by exception, completed staff work, joint cognitive systems, scalable oversight) assumed subordinates that are cheap, tireless and write their own briefs: **legible delegation**. Delegation is the goal; legibility is the constraint.

## 2. What the town already has

Several pieces exist in a first form, and §11 builds on them rather than replacing them:

- **Rollup format** (`packages/schema/src/rollup.ts`, prompt in `packages/core/src/prompts.ts` `managerIntrayBlock`): Shipped items with "What it is / What you'd see / Your call", Decided, Key results, Needs from the captain; at most 3 items, 2 pictures, 80 words a "What it is". `submit_report` refuses a malformed rollup. This is the record format and it stays.
- **Needs rule** (`rollupNeedsRule`): at most 2 Needs, and never an item already waiting elsewhere; the town appends the "Already waiting in your in-tray" line itself.
- **Folding** (`packages/core/src/rollup-asks.ts`): a rollup that only says "go fund gr_x" is acknowledged on submit and its line is carried on gr_x's own row (`asks` on `GrantView`). Mitchell, 1:1 mt_7b4zc7yja3: "it's irritating to have reports that basically say 'go look at your grants and fund gr_xxxx'". This is the seed of §4's dedupe-by-target.
- **Overtaken** (`packages/core/src/secretary.ts` `overtakenReason`): a rollup call whose grant was since decided, or whose key result was since marked, is labelled overtaken. This is the seed of §4's retire-on-event, but it runs on regexes over prose at digest time, not on the item when the event fires.
- **The Secretary** (same file; gr_kdlogzzo5s): a daily digest card, "Decisions needed" grouped by kind of yes/no (Money, Go / no-go, Questions in words, Already overtaken, Errands) assembled in code, "Shipped since last digest" written by a cheap-model run; archives rollups that ask nothing. And `act_in_1on1`: in a 1:1 it decides as the human, citing their words, never on its own judgment.
- **Review deck** (`packages/core/src/review-deck.ts`): the in-tray as slides, most blocking first; a 1:1 can pin a deck.
- **Grant steps and the estimator**: a proposal carries 1-5 steps, "one session each"; funding queues step 1 and each step's report queues the next (grant B, 2026-11-05). `packages/core/src/grant-estimate.ts` reads the three nearest closed grants for a spend range and the median spent ÷ funded, collective-wide and per building.
- **The checkpoint rule** (`Grants.checkpoints` in `packages/core/src/grants.ts`): a funded grant holds when spend reaches its tokens minus min(150k, a third); new sessions wait for a human to continue, adjust or cut; after a continue it holds again at 100%. The card assembles itself from the forks' reports.
- **Escalation criteria** in the manager prompt (`ESCALATION_CRITERIA`), and a 4-hour minimum gap between rollups.
- **Key-result statuses** (`KeyResultStatus`: not-started, on-track, at-risk, claimed, met, missed); agents may set the first four, only a human marks met or missed.

**Built on 2026-11-09** (§11 steps 1-8, on the legible-delegation branch), so a reader knows where the code is:

- `packages/core/src/asks.ts`: the `asks` table's service. Asks created at their sources, folded by target, retired by event, decided by a human; the town-written money cards (`proposalCard`, `gateCard`); the Secretary's rank. Invariants in `docs/invariants/asks.md`.
- `packages/schema/src/ask.ts`: the card contract per ask type and the countable STE linter (`vetAsk`).
- `packages/core/src/seen.ts`: the `seen` table and the reader's delta.
- `packages/core/src/ask-checks.ts`: claim checks (`pr`, `url`, `api`, `kr`, `manual`), run at render and on open.
- `packages/core/src/notices.ts`: the `notices` table (shipped, closed loop, verified, slate, pattern, gate) and `/api/notices`. Invariants in `docs/invariants/notices.md`.
- `packages/core/src/grant-forecast.ts`: the forecast at every step report, and the gate it files: a money ask past the ceiling, a `gate` notice within it.
- `packages/core/src/circuit-breaker.ts`: the per-session circuit breaker.
- `packages/core/src/free-tokens.ts` and `packages/core/src/grant-estimate.ts`: earmarks at expected spend under the oversell setting, and spent over size per size.
- Measures and the dictionary (step 10) land in `packages/core/src/measures.ts` when that step merges.

Why it isn't enough (before 2026-11-09): the ask was still **parsed out of prose** after the fact. The Secretary's digest "takes the questions my brain can barely parse and puts them in a bulleted list": its Money lines re-list the cards and its "Questions in words" truncate at 150 characters, which cuts off the actual question. There is no delta against what the reader last saw, no ranking, and the real decisions ("Your call: None, unless you'd rather …") are not asks at all today. And the checkpoint rule fires on spend, where nothing has been learned, rather than at a step boundary, where something has (§7).

## 3. The model: a stream with three kinds of particle

**Mitchell said:** "the human is the bottleneck and the thing they're processing is like a stream of events. i would even visualize it like a fire hydrant in the town hall. and then the secretary's job becomes moving things around in the stream, and also applying learned policy decisions."

**Proposed.** Everything that reaches the Town Hall is one of three particles, and the in-tray stops mixing them:

| Particle | What it is | Who reads it | Examples |
|---|---|---|---|
| **Ask** | Something only a human can do, typed and targeted (§4) | The captain, in the in-tray | fund gr_x; accept captain ask cr_y; reissue a token; "keep this rule?" |
| **Notice** | A state change with nothing to do (§8) | Anyone, in a feed | a grant closed and returned 475k; a stranger joined; a step landed on budget |
| **Record** | The full account: rollups, grant plans, fork reports, checkpoint evidence | Nobody in the stream; one click down from an ask or notice | every rollup and grant as written today |

A rollup emits zero or more asks plus notices and is itself a record. A grant proposal emits exactly one ask (money) and is itself the record. **Mitchell said:** "the grant is the full plan, but the ask is the thing the human needs to decide on." Checkpoints, retainers, outbox requests, captain asks and access requests each emit one ask.

The Secretary is a **stream processor** with a small, visible set of operators (§6): render, dedupe, retire, rank, defer. Every operator leaves a mark on the particle, so an ask that was folded or retired flows past stamped rather than vanishing. The human can always see what they did not have to see.

The hydrant is literal: a Town Hall object the stream pours from, with the Secretary beside it, in the pixel town. The in-tray is where asks settle; the feed is where notices flow past.

## 4. Asks: first-class, typed, contracted, never decided by silence

**Proposed.** An ask is a stored object, not a regex match over a report. It has a type, and each type has a **contract**: the fields it must fill before the server accepts it, the way a grant must carry key results today. Every ask is completed staff work: it arrives with a recommendation, both branches and the reasoning, and **nothing happens until a human acts**. There are no defaults and no deadlines that decide anything.

**Mitchell said:** "i don't want policy changes sneaking into the config just because i took a vacation."

| Type | What the human does | Contract (what the card must carry) |
|---|---|---|
| **money** | fund / counter / reject a proposal; continue / adjust / cut a grant at its gate; approve a retainer | the human's own prior decision on this grant and when; spent against funded; steps done and left; the forecast at completion (§7); each branch and what follows from it; the manager's recommendation; 1-2 load-bearing claims with their check |
| **click** | an action in the town UI or on a service only a human may touch | who is parked on it and since when; what the click unblocks; the one-time permission that would make this ask never recur |
| **credential** | issue, reissue or scope a token or key | the exact scope; which key result it unblocks; the fallback if refused |
| **meeting** | a 1:1 or meeting the manager wants | the one question to settle; the manager's recommended answer, so the human can reply in a line instead of meeting |
| **policy** | keep or change a rule the manager applied, or a procedure the Planner proposes changing (§7) | the rule as a sentence; what the manager did; what reversing costs; where the rule would be written; for a Planner proposal, the data behind it |

Key-result flips are not asks. The manager records its reading with an evidence class, **verified** or **claimed** (§5), the grant close shows "4 verified, 1 claimed", and a human flips one from the grant page whenever they like.

Every ask also carries: `targetKind` + `targetId` (the grant, request, key result, rule or schedule it is about), the record it came from, the building, when it was created, and its status: open, decided (by whom, how), retired (by which event), folded (into which ask), deferred (until which event).

**Lifecycle.**

1. **Created** by the manager session that wrote the record (§5), when a rollup is filed, a grant proposed or held at a gate, a retainer asked, an outbox request opened, a captain or access request made.
2. **Deduped by target**: a second ask on the same target folds into the first and adds its line, as `rollup-asks.ts` does for grants today. The captain-accept click asked in three places becomes one ask with three sources.
3. **Retired by event**: when the target's deciding event fires (grant decided, access granted, captain accepted, key result patched, PR merged, request claimed), the ask retires with the event named. The Let-in ask that stayed pending two days after the click is the bug this removes. This generalises `overtakenReason` from a digest-time regex to an event hook.
4. **Ranked** and **deferred** (§6).
5. **Decided** by the human: a button, or via the Secretary in a 1:1 citing their words (`act_in_1on1`). Never by the town.
6. **Logged**: every decision is an event, and the ask keeps its history like a grant does.

This replaces the "## Needs from Mitchell" prose and the "Your call:" lines as the channel for asks. The rollup keeps both sections as the **record** of what was asked, but the server reads asks from the typed list the manager files alongside the rollup, not from the prose. A rollup whose every ask is folded or none is archived on submit, as the Secretary does today, and lives one click down.

## 5. Rendering for review

**Mitchell said:** "ideally you don't get to the confused part. decoupling reports from asks really gives us a lot of green field space to do whatever is needed to help the human get the context easily." And on who writes the ask: "we probably want the model that just finished writing the report to also make the ask, just because it's got the context cached already."

**Proposed.** Two stages, never one. **Stage one, solve and source**: the manager's rollup, the forks' reports, the grant plan, written as today, rich, with every id. **Stage two, render for review**: the ask card, written by the same manager session right after the record, with the cache warm, under three rules.

**Diff-first.** The card's context is a diff against what the reader has seen and said, never a briefing from scratch. The server knows when this human last decided on this grant or building and what they said in 1:1s; it does not yet know what they **viewed**, so a small `seen` table (human, target, time) is part of the build (§11 step 3). The ask prompt then carries: "Mitchell last opened this grant's card on Nov 2, funded it Oct 31 at 600k, said X in the Nov 4 1:1, has not read reports A and B." The model works out the gap from that list, which is what a model is good at. The rollups already do the best version of this ("You picked MIT in your 1:1 with Pix"). People reload fastest from their own prior words.

**80% STE.** Sentences of at most 20 words. One instruction or one idea per sentence. Active voice. Conditions before the actions they affect ("If you cut: …", not "… or cut it, in which case …"). Warnings next to the step they affect, not three lines later. No ids in the card body: names, with the id one hover away (UI / UX's open proposal gr_irjtu6tknu does this for reports). No semicolons, no parentheses. Each type's contract fields present. Facts, numbers, identifiers and hedges ("only", "unless", "not verified") preserved from the record; the card may not add a fact the record does not hold. The ASD-STE100 maintainers' own warning applies: plausibility is not compliance, so the **server lints** the card against the countable rules and bounces a failing card to its author the way `submit_report` bounces a malformed rollup today.

**Load-bearing claims, pre-checked.** Each money ask names the one or two claims that would change the decision if they were wrong, with how to check each. Where the check is mechanical (a PR is green and mergeable, a URL answers 200, an API field has a value, a key result's `howToCheck` is a curl), the server runs it when the card is rendered and again when it is opened, and shows the result on the card. A clean card invites a rubber stamp; "PR #392: green, mergeable, checked 4 min ago" earns one.

**Structure is small.** The structured part of an ask is only what prose cannot do: the type, the target id (for dedupe and retire), the branches as labels (the card's buttons), the recommendation, the claims with their checks. The body is free prose, linted. No sentence is filled from a template. **Mitchell said:** "i'm not sure about the slots … what does that buy us? formatting consistency?" It buys refusal of an incomplete ask, dedupe, and buttons; nothing else is structured.

**Multimodal where it is cheap.** Pictures of what shipped already exist. A grant's step strip (sizes, done, left, spent) is drawn by the server from data, no model. The funding slate (§6) is the interactive rung: toggle and watch the Bank move. Model-drawn diagrams stay rare.

A real ask from Prod rollup #41 (dc_tzb1f3dbao) as written:

> Continue gr_q1jrelx2ty at its checkpoint (about 150,000 more is enough: one session merges PR #392 and closes it) or cut it, in which case the docs PR merges under exploration and its second key result stays unclaimed.

The same ask as a card:

> **Prod asks for 150k more tokens to finish the self-host grant.**
> You funded this at 600k on Oct 31. It has spent 474k. Three of four steps shipped. A stranger can now run a town from a published image, and CI restores a backup from it on every green main.
> One step is left. A docs PR points self-host path B at the image. One session does it.
> If you continue: 150k, then the grant closes.
> If you cut: the PR merges under exploration. One key result stays unclaimed.
> Cleo recommends continue.
> Check: PR #392 is green and mergeable. ✓ 4 min ago.

Same facts, both branches, the reader's own decision as the anchor, a recommendation, a verified claim. The ids and the 900-word rollup are one click down.

**A town dictionary.** One meaning per word, enforced by the linter, starting with the words the in-tray already overloads. Key-result evidence today is a sentence ("met on code evidence only: you were the only admin online"); it becomes a field with three values, **verified** (seen live by a human or a check the server ran), **claimed** (the fork's report says so), **unknown**. The status zoo (claimed, met, on-track, at-risk, held, at checkpoint, not-started) shrinks to what a card needs. The dictionary is a Town Hall doc every manager's prompt pins.

## 6. The Secretary as stream processor

**Mitchell said:** "the secretary should be fable by default. this kind of high-level judgment work i think requires that level of competence."

**Proposed.** The Secretary stops writing a digest and starts operating the stream, on Fable. Its operators, each visible as a stamp on the particle:

- **Dedupe** and **retire**: §4 steps 2-3, mechanical, in code.
- **Rank**: an order over the open asks. Money asks come as a **slate**: "fund these four now, and why; hold these three until X ships; skip these three, they overlap Y". The human decides every card, but starts from a recommendation instead of ten unordered cards. Fund and reject history, with the notes, is the material for the next slate.
- **Defer**: park an ask behind the event it is moot without (the continue on gr_bwm0iz7rwl waits behind the captain-accept click, not beside it).
- **Propose a rule**: every time the human decides a policy ask, or says "obviously X" or "don't ask me about this" in a 1:1, the Secretary drafts a one-line rule and files it as a policy ask: "add this to the ledger?". The **policy ledger** is a Town Hall doc, one rule per line with its origin (meeting or decision id), pinned in every manager's prompt, so managers stop asking what is already written. The Secretary never applies a rule itself; the ledger steers the managers, and the human edits the statute.
- **Surface patterns**: the "step back" work never comes from a leaf. Weekly, the Secretary files one notice of convergences and repeats: "four buildings hit the test account's permissions this week", "ten proposals landed in one day because the explore tick fired after a deploy". A pattern notice may carry a policy ask.

The Secretary never funds, continues, cuts or approves anything itself, as today. Its quality metric is in §9: how often an ask still ends in a 1:1.

## 7. Money stays human, and grants are priced by step

**Mitchell said:** "i don't really want auto approving grants. that's a key steering point that i think should stay. and it's part of the ethos of the project: it's collectively funded, and we keep the budget for a reason. one of the product assumptions here is that people will stop token maxing once they start seeing the bills. of course the level of autonomy will increase as tokens get cheaper and models get better. but i see that scaling as happening within the grant size. you just trust the model with bigger chunks of work because they're more capable, and the work costs less so there's less risk if it gets it wrong."

**Proposed.** No money ask is ever decided by the town. Not proposals, not gates, not retainers, not top-ups. What changes is how a grant is priced, where it holds, and what the human sees when it does.

### 7.1 What the data says

- **Checkpoints are top-ups.** Of 63 checkpoints on prod, 41 were followed by adjust (nearly always more tokens), 8 by close, 3 by continue, 8 by cut or stop. 52 of 60 decided holds were "keep going", and every one waited days for it. About 90% of funded grants have held at least once.
- **Session cost is bimodal, by the kind of step, not by the grant.** 663 grant-lane sessions: median 39k adjusted tokens, p90 124k, p99 250k. The 13 transcripts read split cleanly: verify, re-check and checkpoint steps at about 35k (7-19 tool calls, one edit at most); build steps (new modules, migrations, tests, docs, a PR) at 190-330k (33-129 tool calls, 10-56 files). The fat tail is **legitimate work, not thrashing**: the worst repetition was a census script run ~20 times while tuning a constant, and no identical failing command recurred past about six times.
- **Small grants overrun, big grants underrun.** 120k → 204k, 133k → 218k, 160k → 247k; 1M → 314k, 1M → 515k, 2M → 971k. A session is a coarse unit against a 120k grant and a fine one against 2M.
- **A per-session cap at 100k would cut real work.** By turn count it would land before the first commit in 8 of 9 long sessions. Context gathering is 40-60% of a long session's tool calls, not 10%; the steady cost is cache writes at ~3× output (each turn's new tool results), and a cold cache start costs ~60k of cache write on turn one. Fable sessions run ~6k adjusted tokens a turn against ~2.5k on Opus.
- **The cache fix of 2026-11-05 cut the middle of the distribution by 20-30% and left the tail alone.** Historical ratios overstate today's spend.
- **Grants are not reserved.** `BUDGET_POLICY.grantReservations` is off: a grant's tokens are an earmark on the general balance, not a locked pot. Overrun draws free tokens; when free tokens reach zero everything holds. The Bank is already the hard ceiling, and stays so: never a token beyond what was donated.

### 7.2 Lessons borrowed

Fixed-price contracts make the contractor pad; time-and-materials makes the buyer monitor; consulting settled on **T&M with a not-to-exceed cap**. **Stage-gate** funding (pharma, venture) places gates at information boundaries, not spend thresholds. **Earned value management** forecasts total cost from work done over cost so far, without predicting a single turn. **Reference-class forecasting** replaces an inside-view guess with what similar things cost. The **no-estimates** school slices work into bounded items, counts them and forecasts from the empirical distribution. **Overbooking** (airlines) sells on expected no-shows with a known valve for the overflow. The halting problem is real in the limit, and engineering's answer to it has always been a bound and a distribution, never a prediction.

### 7.3 The design

1. **Steps carry a size, not a token guess.** A proposal's steps are S, M or L, chosen by the manager when it writes the plan. The manager never writes a token number. No XL: a step that does not fit L is split (the slicing rule, and the protection against overfitting sizes to one collective's history).
2. **A size table prices them, per collective.** Seeded defaults on a roughly doubling scale (proposed S 50k, M 150k, L 400k); edited by the collective's admin; **recalibration is proposed by the Planner and decided by a human** (§7.4), never applied by itself. Small samples stay with the seed. The grant's ask is the sum; the arithmetic is the town's.
3. **T&M with a ceiling.** The grant runs to its sum with no hold. At the ceiling it holds, and only there. Overrun above the ceiling is bounded by the session in flight, which finishes and books; a far circuit breaker on any session (around the largest ever seen, ~500k) is the only per-session limit.
4. **Gates at step reports.** Every step's report carries the forecast: steps done and left by size, spent so far, spend over size so far, projected total. On track is a **notice**. Projected past the ceiling, or a size running hot, is a **money ask** with a recommendation ("raise the ceiling by 150k to finish, or cut here"), filed while the next step keeps running. The ask arrives before it blocks; today 41 top-ups each arrived after the work had stopped.
5. **Earmarks at expected, not ceiling.** Free tokens subtract each funded grant's **expected** remaining spend (its sizes at the table's calibrated actuals), not its ceiling. One per-collective setting says how far the Bank may oversell: 0% reproduces today's behaviour, 100% earmarks at expected. The valve is the existing hold when free tokens reach zero; a held grant is the bumped passenger. The Bank floor stays hard.
6. **Money stays human at every gate.** Fund, raise, cut: a person, every time, from a card that carries the forecast.

Autonomy grows inside the grant: bigger steps, more of them, longer stop conditions, as models earn it. The approval stays.

### 7.4 Health signals and the Planner

**Mitchell said:** "if you start seeing a lot of asks for top ups, then that is like a health signal that we can monitor. and then maybe the planner agent in the town hall alerts on that and proposes changes to operating procedures."

**Proposed.** The Planner (the Town Hall's manager) watches a small set of counts and, when one crosses its line, files a **policy ask** with the data and one concrete change. For now the only levers are the number of sizes and each size's value.

| Signal | What it means | The Planner's proposal |
|---|---|---|
| top-up asks per funded grant; share of grants holding before done | the sizes are priced low, or steps are oversized | raise a size, or require that size to split |
| spent over size, per size and per building, with sample counts | calibration drift, or one building sizing optimistically | recalibrate the table; a per-building notice, not an ask |
| sessions per step | parks, resumes, cold-cache restarts inflating cost | a notice to the building |
| tokens held at gates, and for how long | the human is the bottleneck on money | a slate (§6), or a smaller oversell |

A table change is a change to the collective's operating procedure: the human approves it like any policy ask, and the ledger records why. The loop is "cases to statute" applied to budgets.

## 8. Notices: what shipped

**Mitchell said:** "where do 'cool things shipped that you asked for' fit in? … i would still like to see what got shipped."

**Proposed.** Two channels, neither in the in-tray:

- **The feed.** Every Shipped item of every rollup, as its "What you'd see" line and picture, in time order, filtered by building or goal. Zero decisions. Scroll when you feel like it. Step gates that land on budget flow here too.
- **Closed loops.** A smaller set, surfaced beside the asks because they are the human's past decisions paying off: "You funded this on Oct 31 for 600k. It closed today at 524k. Here is what it bought", with the pictures. One per grant close, one per directed ask that ships, one per key result verified live. This is the bill-to-value feedback the product thesis depends on, and it is the part that made the early days feel good.

## 9. Measures

What the town should count, so the design can be checked against the drudgery it set out to remove:

- **Asks per distinct target** (duplication; 24 items were about 14 targets).
- **Time to decision** per ask type, and the oldest open ask (3.7 days on 2026-11-08).
- **1:1 rate**: the share of asks the human opened a 1:1 about before deciding. The Secretary's quality metric: each such 1:1 transcript says what context the card lacked.
- **Retired before read**: asks the stream retired on an event before the human saw them.
- **Stale records**: rollups the human opened from a card versus never (if nobody drills down, the card carried enough).
- The §7.4 budget signals: top-ups per grant, hold share, spend over size, sessions per step, tokens held at gates.

These fit the "Town health" tab proposed in gr_8bxoy2heif.

## 10. Who pays for what

Explorers that write proposals are forks on the building's work model (Opus everywhere today), inside the 100k exploration chunk; the Fable manager does not write proposals. Of the last 200 sessions on prod, 101 were Fable manager sessions and 99 were work sessions, so the manage lane is already the larger cost centre, and nothing in this doc moves work into it: asks are written in the manager session that already wrote the rollup, with its cache warm, at a few thousand extra tokens. The Secretary and Planner runs move to Fable (§6, §7.4); they are a handful of sessions a day.

## 11. Build order

Each step is grant-sized: one proposal, S/M/L steps, key results a human checks live. The Workshop owns core, schema and server; UI / UX owns the web. Steps 1-2 unblock B; A can land any time. The §7 budget work (steps 6-8) is independent of the ask work (1-5) and can run in parallel.

**Town Workshop**

1. **Asks as a table.** Migration: `asks` (id, type, targetKind, targetId, buildingId, sourceDocId, title, body, branches, recommendation, claims, status, history). `townHallIntray` in `packages/core/src/domain.ts` returns `asks` beside the records; `/api/buildings/:id/intray` and the review deck read from it; the old `reports` + `grants` shape stays one release for the web. Asks are created in code where their sources are created today: `Grants.propose` / gates / `decide` in `packages/core/src/grants.ts`, retainers, `request_human`, captain and access requests. For rollups, `submit_report` with `rollup: true` takes a typed `asks` list (schema beside `parseRollup` in `packages/schema/src/rollup.ts`) and refuses a Needs or "Your call" that names an ask not in the list; the prose stays as the record. A backfill creates asks from everything open at migration time. Folding moves from `rollup-asks.ts` regexes to the table. **Built** (e3841947): `asks.ts`, the `asks` table, sources in `grants.ts`, retainers, outbox, captain and access requests, typed rollup asks, and the boot backfill.
2. **Dedupe and retire.** Event hooks: grant decided, access granted, captain accepted, key result patched, PR merged, request claimed or declined, retire or fold the asks on that target. `overtakenReason` in `secretary.ts` becomes the hook's test. Key result: the 2026-11-08 Let-in case can't recur; a second rollup on the same target adds a source line, not a card. **Built with step 1** (e3841947): `createAsk` folds by target, `retireAsks` runs beside each deciding event.
3. **The card, the linter and the seen table.** `packages/schema/src/ask.ts`: the per-type contract and the countable STE rules (sentence length, no ids in body, no semicolons or parentheses, branches present, recommendation present, delta line present); `submit_report` and `propose_grant` lint the card and bounce with the rule that failed. A `seen` table records which cards and records each human opened; the ask prompt in `managerIntrayBlock` carries the reader's delta (last seen, last decided, last said) computed in core. **Built** (962c874d, ba3e405f): `packages/schema/src/ask.ts`, `seen.ts`; a failing card bounces twice and is filed tagged lint-failed on the third try.
4. **Load-bearing claims with checks.** Claims carry a check kind: `pr` (GitHub status of a PR), `url` (status code), `api` (a path into a JSON response), `kr` (the key result's `howToCheck`, when it is a curl), `manual`. The server runs mechanical checks at render and on open (cached a few minutes) and stores the result on the ask. **Built** (ba3e405f): `ask-checks.ts`, background checks only where the server turns them on.
5. **Rank, defer, ledger, notices.** `rank` on asks; the Secretary's run (today's `DIGEST_RUN_PROMPT`, moved to Fable) becomes a ranking run over money asks that files the slate as a notice with reasons, and defers asks parked behind another. The policy ledger doc type, pinned in `managerIntrayBlock`; the "add this rule?" ask after a policy decision or `act_in_1on1`. A `notices` table and `/api/notices` with building and goal filters, written at rollup submit (each Shipped item), grant close (the closed loop), key-result verification and on-budget gates. Digest cards stop. **Built** (84c910ab, c5d2a8a4, 4bebec12, cbe241c5): the Secretary's ranking run on Fable, `deferAsk`, the policy ledger, `notices.ts`; the in-tray lists asks in rank order. On-budget gate notices came with step 7.
6. **Step sizes and the table.** `steps[].size` (S/M/L) on `propose_grant`, required; `collective.stepSizes` with seeded defaults, editable by an admin; `askTokens` becomes computed and read-only; `grant-estimate.ts` reports spent over size per size and per building, recency-weighted. No XL: `propose_grant` refuses a step marked larger than L and says to split it. **Built** (40816fe7).
7. **T&M, the ceiling and the gates.** `Grants.checkpoints` holds at 100% of the sum only; the reserve rule goes. Each step's `submit_report` computes the forecast (done and left by size, spent, spent over size, projected total) onto the grant and files a notice, or a money ask when projected past the ceiling. One circuit breaker per session (`SESSION_CIRCUIT_BREAKER`, ~500k adjusted) replaces nothing and catches runaways. `docs/invariants/grants.md` gains "a grant holds only at its ceiling; an ask precedes every hold". **Built** (40816fe7, 9d67da6f): `grant-forecast.ts`, `circuit-breaker.ts`. Past the ceiling the forecast is one Adjust / Cut money ask with a town-written card that passes the money contract, and the hold folds into it; within the ceiling it is a `gate` notice. A running grant can be adjusted, or cut, which stops it. `docs/invariants/grants.md` invariants 5 and 12.
8. **Overbooking and the oversell setting.** `Bank.freeTokens` subtracts expected remaining (sizes at calibrated actuals) scaled by `collective.oversell` (0-100%, default to be set, §12); the hold when free tokens reach zero is unchanged. `docs/invariants/bank.md` gains the floor statement. **Built** (dbef6b78): `free-tokens.ts`.
9. **The Planner's signals.** The §7.4 counts on `/api/health` and the Town health tab; the Planner's scheduled run reads them and files a policy ask with the data when a line is crossed, on Fable.
10. **Dictionary and evidence class.** Key-result evidence as `verified | claimed | unknown` (a column beside `status`, set by the fork's report and by a human or a passed check); the dictionary doc; the linter reads it.

**UI / UX**

- **A. The hydrant.** A Town Hall object the stream pours from, the Secretary at it; particles move; asks settle into the tray, notices flow to the feed, stamped ones carry their stamp. Visible from the map.
- **B. The ask card.** One component replaces the in-tray rows and `RollupCards.tsx` for asks: the contract layout of §5 (delta line, body, branches as the buttons, recommendation, claims with check status, sources, the record one click down). Names, not ids (gr_irjtu6tknu). Works on a phone.
- **C. The funding view.** The slate as a page: toggle fund or hold per proposal, Bank balance, expected spend and runway update live, then decide per card; nothing is funded by the toggle. Grant cards show the step strip (sizes, done, spent) drawn from data.
- **D. The feed and closed loops.** The notices channel of §8, with pictures; closed loops beside the asks.
- **E. The deck and the table.** The review deck reads the ranked asks; slides in rank order; the first slide is the slate. The step-size table and the oversell setting on the planning desk, with the Planner's calibration proposal shown as the ask it is.

## 12. Open questions for Mitchell

1. **The seed values.** S 50k, M 150k, L 400k is a doubling-ish scale that brackets this collective's two observed modes (~35k, ~250k). Fine as a seed, or start from the measured modes?
2. **The oversell default.** 0% is today's behaviour; 100% earmarks at expected. Proposed: 50% for the Workshop until the Planner has one calibration cycle of data, 0% as the seed for a new collective.
3. **Fable steps.** A check step run by a Fable manager costs ~6k a turn against ~2.5k on Opus. Does the size table have a model axis, or does a Fable step simply pick the next size up?
4. **Lint strictness.** Does a card that fails the STE rules bounce (the author rewrites it) or file with a warning badge? Proposed: bounce, as `submit_report` does for a malformed rollup, with a 3-strike fallback that files it flagged.
5. **Does the human ever see a rollup in the in-tray?** Proposed: no; a rollup is a record reached from its asks and notices, and the manager's Decided list is for audit.
6. **The Planner's lines.** What top-up rate or hold share triggers a calibration proposal? Proposed: 30 steps of a size with spend over size outside 0.7-1.3, or more than a quarter of grants holding before done in a 14-day window.
7. **The name.** "Ask" is used here; the town also says "call", "decision" and "Needs". One word, in the dictionary.
