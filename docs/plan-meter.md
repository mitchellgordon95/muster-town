# Subscription accounting: why the Bank's number is wrong, and the live plan meter

Author: Claude Code (Mitchell's session). 2026-10-21. Status: **proposed**, not built.

## The problem

The Bank's subscription input is a paper budget in raw tokens (input + output + cache reads + cache creation, as the
SDK reports them). When its daily credit is used up, `fundingFor` treats the subscription as capped and starts the next
session on the API key. On 2026-10-21 that happened within hours while Mitchell's real Max 5x meter read 7% of the
weekly limit. Subscription tokens are heavily subsidised relative to API list price, so the real allowance is at least
ten times the 20M a day the Bank assumed. About $17 of the $50 API-key buffer went on sessions the plan could have
carried.

## Interim fix (done)

The workshop's subscription input was replaced with 40M a day and a 280M weekly cap, derived from "7% of a week ≈ the
Fable session plus the town's 20M". That figure is a guess: the weekly window had reset about 4.5 hours before the
screenshot, so the town's earlier 20M was in last week's window. Correct it from the next meter reading by dividing
tokens pushed by percentage points moved.

## What exposes the real quota

- **`rate_limit_event` messages in the Agent SDK stream** (`SDKRateLimitEvent`, SDK 0.3.x). Each carries
  `rate_limit_info`: `status` (`allowed`, `allowed_warning`, `rejected`), `rateLimitType` (`five_hour`, `seven_day`,
  `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`), `utilization`, `resetsAt`, and
  overage fields. It needs no extra OAuth scope. The town ignores these today.
- **The structured usage query** (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, the data behind `/usage`):
  per-window utilization and reset times, per-model windows, extra-usage credits. It needs the `user:profile` scope.
  Tokens from `claude setup-token` lack it (`/api/oauth/usage` answers `oauth_scope_insufficient`).
- Neither returns an absolute token allowance. The ratio comes from tokens pushed divided by utilization moved.

## Proposal

1. Desks and in-process sessions forward each `rate_limit_event` to the server (a small verb or REST call).
2. The Bank stores the latest utilization and reset per window and shows it on the subscription input.
3. `fundingFor` keeps sessions on the subscription until a window reports `allowed_warning` past a threshold the admin
   sets, or `rejected`. Then it switches to the API key until that window's `resetsAt`. The existing failover on a
   spend-limit message stays as the backstop.
4. The Bank keeps recording raw token use against the subscription for legibility, but no longer gates on it.
5. Estimate tokens per percent over time, so the daily credit can be shown in plan terms.

Open: whether the five-hour window should hold sessions until it resets instead of spending the key.

## Related facts from the same session

- A work slot busy around the clock burns about 5M raw tokens an hour, roughly $3 an hour on the key.
- A running desk costs about 0.2 GB of memory, 0.7 GB while compiling; idle desks cost nothing (Cleo's measurements,
  dc_klkyolse8o and dc_fnlpbktrr5 in the workshop). `desks.maxRunning` caps concurrency (docs/architecture.md).
