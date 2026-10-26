# The Bank: token counters

Bank grant gr_iq5m7dug56 moves the Bank from one raw token number to what tokens actually cost. Plan: dc_2uqmfdittg. Step 1 (this note) records the breakdown everywhere; step 2 (`adjustedOutputTokens` in `core/src/bank.ts`) puts a price on it. Step 2 derives the adjusted figure and shows it next to the raw one; nothing is charged in it yet (step 3), so every total, balance and budget still reads in raw tokens.

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

The desk posts `counts` and `byModel` with `tokens` (their sum) to `POST /api/agents/me/session-end`. An older desk that posts only `tokens` is handled by the back-fill rule below.

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

A session with several models (a Fable session's Haiku subagent) keeps `byModel` (migration 035); each model's counters are priced at that model's list price and the sum is expressed in the session model's output tokens (`adjustedOfUsage`).

Where it shows (always next to `tokens` and the five counters):
- `GET /api/sessions?agentId=&limit=` (new; newest first), `GET /api/agents/:id` `currentSession`, `GET /api/agents/:id/session`.
- events: `session.ended`, `bank.input`, `bank.credited` carry `adjustedOutputTokens`.
- `GET /api/bank` (the Bank page's payload): `creditedCounts` and `adjustedCreditedTokens`, overall and per input.

Calibration (2026-10-26, the last 50 `session.ended` with a `costUsd`, 16:41 to 20:30 UTC): for the 4 sessions with a real breakdown, list cost of the counters / `costUsd` = 1.000 (all four within 0.1%). The 46 back-filled ones (desks before step 1 posted only a raw total) are priced at raw / 30 (Opus) or raw / 24 (Fable) by the back-fill rule; against their real cost that is a median 0.85 (p10 0.55, p90 1.36, n 13) for Opus and 0.69 (0.46 to 1.41, n 33) for Fable. Their real raw tokens per adjusted output token: Opus median 25.6 (p10 16.4, p90 40.7), Fable 16.5 (11.0 to 33.7), against the assumed 30 and 24.
