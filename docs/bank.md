# The Bank: token counters

Bank grant gr_iq5m7dug56 moves the Bank from one raw token number to what tokens actually cost. Plan: dc_2uqmfdittg. Step 1 (this note) records the breakdown everywhere; step 2 (`adjustedOutputTokens` in `core/src/bank.ts`) puts a price on it. Step 2 derives the adjusted figure; step 3 (below) enters, books, compares and shows every Bank figure in it.

## The five counters (step 1)

Every row the Bank books keeps five counters: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` (`TOKEN_KINDS` in `packages/schema/src/tokens.ts`).

| table | counters | raw total (generated, never written) |
|---|---|---|
| `sessions` | the five | `tokens` |
| `usage` (ledger behind tokens today / all time) | the five | `tokens` |
| `bank_credits` | the five | `tokens` |
| `bank_debits` | the five | `tokens` |
| `allocations` (what each has paid for) | `spentInput` … `spentCacheWrite1h` | `spentTokens` |

The raw total is a SQLite generated column, the sum of the five (migration `034_token_counters.sql`), so it can't drift. `Table` (core) reads generated columns but never writes them and re-reads a row after each upsert. A pool's balance is still derived from credits minus debits. Bank inputs and allocation sizes stay raw numbers until step 3.

Booking: `Budget.charge` / `recordUsage` take the counters; `Bank.drawTokens` splits them across debits in proportion (`sliceTokens`, largest remainder), so each kind's debits plus the allocation's spend add up to the charge.

Events: `session.ended` carries `model`, `tokens` and the five counters, plus `byModel` when the session reported per-model usage. `bank.input` and `bank.credited` carry the five as well.

## Where the counters come from

The desk (`packages/desk/src/run.ts`) and host sessions (`packages/runtime/src/session.ts`) read each SDK `result` message through `sdkTokenCounts` (schema):

- per model, from `modelUsage[model]`: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`. These are cumulative over the query, subagents included.
- `modelUsage` doesn't split cache writes by TTL. The split comes from `usage.cache_creation` (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`), applied as a ratio to each model's cache writes. When it's missing or zero, all cache writes count as 5m.
- when there's no `modelUsage`, from `usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, under the model `unknown`.

The desk posts `counts` and `byModel` with `tokens` (their sum) to `POST /api/agents/me/session-end`, and its cumulative usage so far as `usage` activity once a minute while it runs (the Bank debits a session as it runs; the session row's counters are always what was debited, docs/invariants/bank.md 13). An older desk that posts only `tokens` is handled by the back-fill rule below.

## Back-fill rule (history and bare totals)

A row with only a raw total (every row from before migration 034, a credit from a raw-sized input, a caller that knows only a total) is split into output plus cache read. The split is chosen so that step 2's adjusted value, `output + cacheRead × (cache-read price / output price)`, comes out at exactly `raw / ratio`, the calibration in dc_2uqmfdittg:

| model | ratio (raw per adjusted) | cache-read weight w | output share |
|---|---|---|---|
| Opus, and any model that isn't Fable | 30 | $0.20 / $20 = 0.01 | (1/30 − 0.01) / (1 − 0.01) = 2.357% |
| Fable | 24 | $0.25 / $50 = 0.005 | (1/24 − 0.005) / (1 − 0.005) = 3.706% |

`output = round(raw × (1/ratio − w) / (1 − w))`, `cacheRead = raw − output`. Input and both cache writes are 0. Example: 30,000 raw on Opus becomes 707 output + 29,293 cache read, which is 1,000 adjusted.

Which model is used: a session uses its own `model`. A credit uses its input's model. Usage rows, debits and allocation spend have no model and count as Opus. The same rule is `splitRaw` in TypeScript and the SQL in migration 034.

Tests: `core/test/token-counters.test.ts` (back-fill math, booking by kind, `session.ended`), `core/test/budget.test.ts` (034 back-fills the ledger), `runtime/test/usage.test.ts` (SDK fields), `server/test/desk.test.ts` (session-end with counters).

## Adjusted output tokens (step 2)

`adjustedOutputTokens(model, counts)` in `packages/core/src/bank.ts` = `output + Σ weight(model, kind) × count`, rounded, where a kind's weight is its list price over the model's output price. It is derived wherever it's shown and never stored.

Prices: `TOKEN_PRICES` in `core/src/bank.ts`, the one table (step 4's drift job reads it too), from https://platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-26. USD per million tokens:

| family (model ids) | input | output | cache read | cache write 5m | cache write 1h | weights in / read / 5m / 1h |
|---|---|---|---|---|---|---|
| Fable 5.1, Mythos 5.1 (`claude-fable-5-1`) | 10 | 50 | 0.25 | 12.50 | 20 | 0.2 / 0.005 / 0.25 / 0.4 |
| Fable 5, Mythos 5 | 10 | 50 | 1 | 12.50 | 20 | 0.2 / 0.02 / 0.25 / 0.4 |
| Opus 5.5 (`claude-opus-5-5`) | 4 | 20 | 0.20 | 5 | 8 | 0.2 / 0.01 / 0.25 / 0.4 |
| Opus 5, 4.5 to 4.8 | 5 | 25 | 0.50 | 6.25 | 10 | 0.2 / 0.02 / 0.25 / 0.4 |
| Opus 4, 4.1 | 15 | 75 | 1.50 | 18.75 | 30 | 0.2 / 0.02 / 0.25 / 0.4 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 2 | 10 | 0.10 | 2.50 | 4 | 0.2 / 0.01 / 0.25 / 0.4 |
| Sonnet 5 | 2 | 10 | 0.20 | 2.50 | 4 | 0.2 / 0.02 / 0.25 / 0.4 |
| Sonnet 4, 4.5, 4.6 | 3 | 15 | 0.30 | 3.75 | 6 | 0.2 / 0.02 / 0.25 / 0.4 |
| Haiku 5.5 (`claude-haiku-5-5`), prompts ≤100k | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 | 0.2 / 0.02 / 0.25 / 0.4 |
| Haiku 4.5 | 1 | 5 | 0.10 | 1.25 | 2 | 0.2 / 0.02 / 0.25 / 0.4 |
| Haiku 3.5 | 0.80 | 4 | 0.08 | 1 | 1.60 | 0.2 / 0.02 / 0.25 / 0.4 |

Haiku 5.5 over 100k-token prompts costs 5× every column, so its weights are the same. A bare alias (`opus`, `fable`, …) is the family's latest. An unknown or missing model is priced as Opus 5.5, and `session.ended` for an unknown model id posts one `system` event (`payload.warning: "unknown-model"`) per model per server process.

A session with several models (a Fable session's Haiku subagent) keeps `byModel` (migration 035); each model's counters are priced at that model's list price and the sum is expressed in the unit model's output tokens (`adjustedOfUsage(model, counts, byModel, unit)`; the Bank's unit is Opus 5.5, see step 3).

Where it shows (always next to `tokens` and the five counters):
- `GET /api/sessions?agentId=&limit=` (new; newest first), `GET /api/agents/:id` `currentSession`, `GET /api/agents/:id/session`.
- events: `session.ended`, `bank.input`, `bank.credited` carry `adjustedOutputTokens`.
- `GET /api/bank` (the Bank page's payload): `creditedCounts` and `adjustedCreditedTokens`, overall and per input.

Calibration (2026-10-26, the last 50 `session.ended` with a `costUsd`, 16:41 to 20:30 UTC): for the 4 sessions with a real breakdown, list cost of the counters / `costUsd` = 1.000 (all four within 0.1%). The 46 back-filled ones (desks before step 1 posted only a raw total) are priced at raw / 30 (Opus) or raw / 24 (Fable) by the back-fill rule; against their real cost that is a median 0.85 (p10 0.55, p90 1.36, n 13) for Opus and 0.69 (0.46 to 1.41, n 33) for Fable. Their real raw tokens per adjusted output token: Opus median 25.6 (p10 16.4, p90 40.7), Fable 16.5 (11.0 to 33.7), against the assumed 30 and 24.

## The Bank counts adjusted output tokens (step 3)

The unit is **adjusted output tokens** ("adj. tokens" in the web client): what the tokens cost, in **Opus 5.5 output tokens** (`BANK_MODEL` in core `bank.ts`; 1:1 mt_cyd2t5ioob decision 1, 2026-11-01). Each model's counters are priced at its own list price and converted at Opus 5.5's output price, $20/MTok: a Fable 5.1 output token books as 2.5, a Haiku 5.5 one as 0.025, an Opus 5.5 one as 1. At the step-1 calibration 1 adj. token ≈ 30 raw tokens on Opus. `GET /api/health` says `accounting: "adjusted"` (`BANK_ACCOUNTING`) and `accountingModel: "claude-opus-5-5"`.

Before 2026-11-01 a charge was booked in its session's own model's output tokens (a Haiku adj. token debited like a Fable one). Nothing stored was migrated: inputs, credits, grants, allocations, balances and every past ledger row stay as they were. Migration 076 adds `sessions.bankModel`: `claude-opus-5-5` on every session started since, NULL on older ones, which stay priced in their own model (`sessionTokens(s)`, the one figure grant, goal, finance and funder spend sum, so they keep matching the ledger). A session that was running across the deploy keeps its own model for its whole life. A credit of A adj. tokens is still entered as A, now meaning A Opus 5.5 output tokens.

Entered and booked in it: Bank inputs (`tokens`, `weeklyCapTokens`, `creditedTokens`), donations and allocations (`tokens`, `spentTokens`), grant asks, grants and their history, a grant's spend and exploration spend (their sessions' `adjustedOutputTokens`, summed), building allowances (`dailyTokensPerAgent`, read by nothing since the daily caps were deleted 2026-10-31; `explorationTokensPerDay`, on goals since migration 065), agents' `spentTokensToday` / `spentTokensTotal`, users' `donatedTokens`, the usage ledger (tokens today / all time), Bank credits and debits, pool and building balances, and a report's stamped `tokens`. Sessions keep `tokens` raw (with `adjustedOutputTokens` derived).

Booking (`booked` in core `bank.ts`): a charge's counters are priced at the session's model (per model with `byModel`) and converted to Opus 5.5 output tokens, so a session's booked tokens equal its `adjustedOutputTokens` (`sessionTokens`). A bare number is already Bank tokens; its counters are the back-fill split of the raw tokens of the same cost (`n × 30` Opus, `n × 24 / 2.5` Fable). A credit of A adj. tokens books `tokens = A` with the back-fill split of `A × ratio`. A draw takes adjusted tokens from each credit and the same share of every counter (`sliceBooked`).

The five counters stay alongside: ledger rows (`usage`, `bank_debits`, `bank_credits`) store `tokens` (adjusted) and the five counters, and `rawTokens` is their generated sum; an allocation stores `spentTokens` (adjusted) and the five `spent…` counters, `spentRawTokens` generated. `GET /api/bank` adds `rawCreditedTokens`; a grant view adds `spentCounts`. In the web client every token figure says "adj. tokens", and hovering the Bank balance, an input's credited figure, an allocation's spend, a grant's progress or a session shows the five counters and the raw total.

Conversion (migration `037_adjusted_tokens.sql`, once): every size above ÷30 (Opus and any non-Fable model) or ÷24 (an input whose model is Fable), rounded; the ledger's `tokens` recomputed from its counters at Opus 5.5 weights (a credit at its input's model). One `bank.converted` event lists every converted input, grant, building and allocation as `[before, after]`. Live figures (2026-10-26): bi_au5kt05vlj 40M/day, cap 280M → 1,333,333/day, cap 9,333,333; bi_foh0utko9b 20M/day, cap 100M → 666,667/day, cap 3,333,333; gr_iq5m7dug56 24,000,000 → 800,000. New defaults: `dailyTokensPerAgent` 350,000, the seed's house budget 1,700,000.

Tests: `core/test/bank-adjusted.test.ts` (037), `core/test/token-counters.test.ts` (booking), `server/test/live.test.ts` (`accounting`), `server/test/desk.test.ts`, `server/test/adjusted.test.ts`.

## Unexpected out-of-tokens deaths (step 5)

Code: `packages/core/src/caps.ts`; GET /api/bank `deaths` and `cap`; the Bank page's "Out-of-tokens deaths and the cap".

**An unexpected out-of-tokens death** (plan dc_2uqmfdittg, KR kr_vyrhhiyotb) is either
- a **cap death**: a session that died on the subscription cap. Read from `bank.cap` (step 4), a `session.ended` whose
  `error` matches SPEND_LIMIT, or, for history before the desk reported it, an `agent.thought` whose text starts
  "You've hit your" and matches SPEND_LIMIT (the SDK's result echoed by the desk; agents' own thoughts about the limit don't
  count). Counted once per session; or
- a **`budget.exhausted`** event (an agent's daily allowance or a building's budget ran out), each event counted.

The Bank warns before neither, so every one is a death it did not predict. The counter is the number of these with a
timestamp in the 7 days before now (rolling). Baseline: 7 in the week to 2026-10-26 by hand count; the event log itself
shows 10 cap-death sessions and 12 `budget.exhausted` for 10-20..10-26. Target: 0.

**No learned cap (removed 2026-11-01).** The Bank used to learn a "daily cap" from the adjusted spend at which sessions
died on the subscription (`bank.cap`), and held every new subscription start near it. On 2026-11-01 one Fable session hit
a Fable-only plan limit ("Switch to another model to continue"); the Bank learned an 8.7M daily cap from it and held all
work, Opus included, for about 22 hours while 6.7M sat in the Bank. A limit inferred from where one session died is not a
limit, so the learned cap and its hold are gone. `bank.cap` events are still logged and counted as deaths, and
`capState().cappedAt` still marks the subscription capped until the reset in the cap message (or the next 00:00 UTC):
while set, the next sessions run on a fallback credential if the Bank owns one (`Budget.failoverFunding`); a session never
carries a second credential to switch to inside itself (1:1 mt_x40qq8poc3). The replacement is availability observed per
credential and model ("Promised and available" below).

## Funding streams and the draw order (goal tree step 7)

Decided in docs/goals.md "Streams" (1:1 mt_529jbnwvmi), go-ahead in 1:1 mt_cz11aqe81a. Migration 064 adds `bank_inputs.goalId` and `idleNotifiedAt`.

- **An earmark** is an api-key input with a `goalId` (POST /api/bank/inputs `goalId`; the Donate form's "Earmark for"). It pays only for sessions whose work sits in that goal's subtree. The general balance never sees it: `Bank.live()` and the durable debits exclude earmarked credits, and the general key picks (`liveApiKeyInput`, `fallbackInput`, `fundingFor`) skip earmarked inputs. A subscription can't be earmarked.
- **Draw order at session start** (`runtime fundingForSession` → `Budget.fundingFor`): the grant's own input (`fundedWith`), then `Streams.pick`: walking up from the work's goal (its grant's `goalId`, else an old grant's or named key result's goal, else the building's attachment, Spend by goal's attribution), the first goal with a live keyed earmark whose balance covers one expected session, oldest first; then the general balance. One credential per session: the earmark's key runs it.
- **Charging**: the session's `credentialInputId`, when it is an earmark, pays first (`Bank.drawFromStream`, debits name the input); what it can't pay goes to the general balance. Nothing is held.
- **Expected session** (`Bank.expectedSession`): the p90 of work sessions that ended in the last 7 days, the building's when it has 5 or more, else the town's, else 120,000. An earmark below it is never picked; it accrues.
- **Small-donation warning**: the Donate form (web `smallDonationWarning`) warns when an amount is below that p90, with the days a recurring one needs to accrue one session. A warning, not a gate.
- **Idle alert**: the runtime tick (`Streams.tick`) tells an earmark's donor, by an in-town message to their avatar, when no session has drawn on it for 7 days (once per 7 days; reason: below one session, or no session in scope). No email or SMS (1:1 mt_kh0zaqui0w).
- **GET /api/bank/streams** (public): every live input and every earmark with its balance, whether it covers a session, days to cover, last draw and idle reason, plus `expectedSessionTokens`. The Bank panel's "Tokens & sources" tab shows it as Streams.
- **One balance** (how-work-gets-done.md §7; PR #169, migration 067): pools are deleted, every building draws the general balance. Free tokens per goal and the optional exploration cap are in docs/goals.md "Free tokens and the optional exploration cap".
- **Exploration reservations** (how-work-gets-done.md §3; PR #173, migration 068): the runtime tick's explore step opens a `bank_reservations` row (one chunk, 100,000 by default) per explorer; while open it claims its tokens less what its sessions spent, and it closes once its assignment ends (core `explore.ts`).
- **Not yet**: the desk's per-session key cap, and the key's own `dailyLimitTokens` (a daily key's `tokens` is its daily amount today).

## The funder filter (goal tree step 8)

Read-only: it books nothing. Core `funders.ts` (`funderWeek`, `funderWeights`) attributes each session in a window by the credential it ran on: a donated api-key input (`credentialInputId`) or a grant's own input (`fundedWith`) makes it **literal** for that donor, whole; any other session is **pooled**, and a subscription donor's share of it is their subscription credits in the window ÷ everyone's (`Bank.creditsSince`). `GET /api/funders/:userId/week` (`me`; sign-in required) and `GET /api/goals/:id/spend?funder=me` read it; the Town Hall in-tray's "Funded by me" view, the deck's "Your week as a funder" slide and the goal tree's filter show it (docs/goals.md build step 8).

## Retainers (1:1 mt_cyd2t5ioob decision 2)

A retainer is standing money for a scheduled job, approved by a human in the Town Hall in-tray and claimed in the Bank; recurring jobs never draw on grants. A schedule carries `tokensPerRun` (Bank tokens, i.e. Opus 5.5 output tokens) and asks for tokensPerRun × runs left. While funded, it is the fourth claim on free tokens (after funded grants' remaining, open asks and reservations): `retainerTokens` = Σ over funded schedules of min(tokensPerRun × runs left, approved total − drawn), with `retainerJobs` counting them (core `free-tokens.ts`, `retainers.ts`). Its runs' sessions (lane `retainer`, sourceId = the schedule) are what it has **drawn**, derived like a grant's spend. Approving is refused (409) when the ask would dip into the operating reserve. Ending the schedule (cancel, last run, paused past its end) releases what it still claims. Rules in full: docs/how-work-gets-done.md §7a.


**Lookahead and missed runs (2026-11-01).** Mitchell: "i think they should claim their tokens before running, but
obviously if its a recurring job we can't do the whole thing, it would be infinity. so maybe we have a setting that
defaults to 6 hours … if the retainer attempts to execute without having any available input, then we just mark it as
missed in the schedule, and the manager who owns it gets an inbox notification." So:

- **The approval is the ceiling; the claim is what is near.** A funded retainer claims tokensPerRun × the runs due within
  the town's `retainerLookaheadHours` (default 6, `PUT /api/town/retainer-lookahead`, an admin), plus what each run
  already fired may still spend, never more than its approved total less drawn. It sorts first in the overdraft walk:
  its runs are due at a time.
- **Missed, not queued.** When a funded retainer's run comes due and no credential serves its model (an observed limit)
  or the walk covers none of its claim, the run is missed: no assignment, a `schedule.skipped` event with `missed: true`,
  and the schedule's `missedRuns` counts the streak (migration 082). The building's manager gets one message on the
  first miss of a streak; the first run that can fire resets the count. The building panel shows "missed N runs".

## Promised and available (2026-11-01)

**Mitchell said** (2026-11-01): "right now i think we consider all donations as 'available' tokens. but in reality there's
a projected / predicted / promised availability, and then there's what actually happens when we try to query with the API
key." A donation's tokens are a promise: the donor's ceiling. Someone may promise 10M on a key loaded with 2M, disable the
key, or share a plan that hits its own limit. The Bank can't know which in advance, so it never predicts a limit. It
observes what the provider says.

**What is observed** (core `availability.ts`, table `credential_limits`, migration 080). Per Bank input and model class
(`fable`, `opus`, `sonnet`, `haiku`, `other`, or `*` for every model):

| The provider said | Kind | Scope | Lifts |
|---|---|---|---|
| "Switch to another model to continue", a per-model weekly window (`seven_day_opus`, …) | model-limit | that model | at the reset it names, else a probe |
| a five-hour or weekly plan limit ("You've hit your limit · resets 3pm (UTC)") | window | every model | at the reset it names, else a probe |
| "credit balance is too low", `billing_error` | billing | every model | a probe |
| `invalid x-api-key`, an expired or revoked OAuth token | auth | every model | a probe |
| overloaded, a transient 429, anything else | nothing | | |

Sources: a session's error at its end (`ops.endSession`), and the SDK's `rate_limit_event` while it runs (host sessions
directly; desks post it as a `rate-limit` activity once their image is rebuilt). `rejected` records the window with its
reset; `allowed` clears it; `allowed_warning` changes nothing.

**Probes.** With no reset named, the limit holds until `probeAt`, when one session may try: 1 h, doubling per failure to
24 h; 6 h doubling to 48 h for billing and auth. A session that succeeds on the input and model clears the limit (an
Opus success clears nothing for Fable). The input's owner or an admin can clear one by hand ("Try now" on the Bank's
inputs, `POST /api/bank/limits/:id/clear`). Each change is a `bank.limit` event.

**Dispatch.** `Budget.fundingFor` takes the session's model (`Budget.sessionModel`: a building-queue row's own model, else
the agent's, else the building's). A limited input is skipped for another credential that serves the same model (an API
key when the subscription is limited); with none, the work waits and its `heldReason` and map line say why ("Max plan:
Fable limited, tries again 2026-11-01 03:28 UTC"). The model is never switched: an unasked drop in quality is worse than
waiting. A member's own input that is limited holds their grant's work; it never falls back to the pool.

**Requeue.** A work session that dies on its credential didn't fail the work: its assignment goes back to the front of the
queue with no fallback report, and dispatch funds it from another credential or holds it with the limit's reason.

**The usable balance** (`Bank.unavailable`, `Bank.usableBalance`). Claims are covered by what sessions can actually draw
on, not by every credit. A credit is left out when its input can't serve any model before the credit runs out:

- a subscription credit whose input has an every-model limit lasting past the credit's expiry (today's quota sits behind a
  reset that comes too late; a five-hour window resetting tonight leaves it in);
- an API key's remaining credit while the key is broken (billing, auth) or limited with no reset named.

A limit on one model (Fable) leaves the credit in: other models can still spend it. Free tokens' `generalTokens` is the
usable balance; `promisedTokens`, `unavailableTokens` and `unavailable` (per input, with the limit's words) show the rest
when there is any.

**The overdraft walk** (`free-tokens.ts`, Mitchell 2026-11-01: "the approved grants go on a queue … once we process the
grants we can and get to the back, the queue should stop. and while this is happening, we can show like an 'overdrafted'
number"). Nothing is stored: every read walks the claims in order against the usable balance after the operating reserve.

1. retainers (their runs are due at a time),
2. funded grants, by when they were funded,
3. open exploration reservations,
4. open proposals' asks (not promises yet, so they soak up a shortfall first and are never listed as overdrafted).

The approved claims the walk doesn't fully cover are `overdrafted`, and their shortfall sums to `overdraftTokens` (the
Bank's Free tokens section shows both in red). A funded grant with nothing covered holds its grant-lane work ("held:
overdrafted, the Bank's usable balance doesn't cover grant gr_… (N tokens short)", map line to the Bank); one straddling
the line runs. It recovers by itself: a key fixed, a reset passed or a new credit, and the next read covers it again. The
walk's result is cached for 5 s, and any new event invalidates it.

## Cancelling an input (2026-11-01)

Cancelling stops an input's future credits and forgets its key (`Bank.cancelInput`). What happens to the credit already
paid in depends on the source:

- **API key:** the credit stays. That money was paid in and the key's balance is the town's until it is spent.
- **Subscription:** the live credit expires at once (`expiresAt` = the cancel time) and the `bank.input` event says how
  many unspent tokens lapsed (`expiredTokens`). A subscription credit is quota the plan serves today, not money; before
  this, replacing a 15M-a-day donation with a 2M one left the old day's 15M spendable until its renewal (the Bank read
  6.7M right after Mitchell set 2M on 2026-11-01).
