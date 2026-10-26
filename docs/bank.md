# The Bank: token counters

Bank grant gr_iq5m7dug56 moves the Bank from one raw token number to what tokens actually cost. Plan: dc_2uqmfdittg. Step 1 (this note) records the breakdown everywhere; step 2 (`adjustedOutputTokens` in `core/src/bank.ts`) puts a price on it. Until step 2 ships, a token is still worth one raw token: every total, balance and budget reads exactly as before.

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
