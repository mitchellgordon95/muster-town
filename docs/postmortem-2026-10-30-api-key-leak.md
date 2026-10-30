# Post-mortem: host sessions billed the API key while recorded as subscription (2026-10-22 to 2026-10-30)

Author: Claude Code (Mitchell's session), 2026-10-30. Status: remediation shipped the same day (see "What changed"); the
reconciliation items under "Still open" are proposals for the workshop.

## What happened

From the move to Fly on 2026-10-22 until 2026-10-30, every session the town ran **in-process on the host** (manager
sessions, meeting facilitation and replies, meeting summaries, the 1:1 chat) was billed to Mitchell's Anthropic API key,
while the town recorded each of them as funded by the subscription. The desk sessions (residents' work in Fly Machines)
really did run on the subscription. Nobody noticed until the Console bill (about $500) did not match the Bank, which
listed no API-key input at all. Mitchell deleted the key in the Console on 2026-10-30; from then until the fix, every
host session failed on the dead key.

Measured from the live town's session rows (list-price estimates from the SDK, host sessions since 2026-10-22; Pix's
rows are capped at the API's 200-per-agent page, so the host figure is a floor):

| backend | purpose | recorded funding | sessions | list cost |
|---|---|---|---|---|
| host | manage | subscription | 426 | $277 |
| host | facilitate | subscription | 13 | $10 |
| host | meeting-reply, summary | subscription / none | 93 | $4 |
| desk (Fly Machine) | work | subscription | 182 | $396 |
| desk (Fly Machine) | work | api-key (real failovers, before 2026-10-27) | 3 | $10 |

So at least about $290 at list price went to the key from the host, every cent of it labelled "subscription" in the
town. (List price and the Console bill differ: cache pricing, the 200-row page cap, and sessions before 2026-10-24
that the API no longer returns.)

## Why

Three things lined up:

1. **Both credentials sat in the host env.** The `.env` the town ran on had `CLAUDE_CODE_OAUTH_TOKEN` (the
   subscription) and `ANTHROPIC_API_KEY` (the "buffer" key). Both were mirrored as Fly secrets on 2026-10-22.
2. **Host sessions were handed both.** `sessionEnv` in `packages/runtime/src/sdk.ts` (Secrets PR 1, 2026-10-21)
   allowlists the host env for a session by prefix, and the prefixes were `CLAUDE_` and `ANTHROPIC_`. Its test asserted
   that both the token and the key came through. **Claude Code uses the API key when both are set** (verified
   2026-10-30: with a valid token and a bogus key, `claude -p` answers "Invalid API key"). The desk's own env builder
   (`packages/desk/src/run.ts`) knew this and dropped the key when it had the token, which is why desk sessions were
   fine. The host path never had that rule.
3. **The town recorded the plan, not the credential.** `session.funding` is what `fundingFor` chose (subscription), the
   `auth: subscription` log line says the same, and nothing checked what the SDK process actually authenticated with.
   The Bank's API-key input had been cancelled on 2026-10-27 (its $50 "buffer" was meant to be used up), so the Bank
   showed no key anywhere, while the env still carried it. The runtime also treated the host's `ANTHROPIC_API_KEY` as an
   implicit fallback (`?? envKey` in `fundingFor` and `deskAuth`): a key the Bank did not list could still be spent.

What did not fail: desk sessions, the failover itself (3 sessions, logged as api-key, charged to the buffer), the Bank's
arithmetic. The accounting was right about the wrong thing.

## What changed (shipped 2026-10-30)

- **One credential per session, or a hard failure.** `assertOneCredential` (runtime `sdk.ts`): the server refuses to
  boot when the host env carries more than one of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
  (`packages/server/src/main.ts` logs the one it found). A desk refuses to start a session handed both
  (`packages/desk/src/run.ts`); the session ends in error, nothing reaches the SDK.
- **Host sessions carry exactly one credential.** `sessionEnv` strips both from the allowlisted env and sets one: the
  funding's own key (a donor's or a Bank input's) → `ANTHROPIC_API_KEY`; else the host's subscription token; else the
  host's key (a host that has no token at all).
- **The host's key is never an implicit funding source** once the host has a token (`hostApiKey`). A failover key is
  only ever one the Bank lists: a donor-key allocation's key or the Bank's api-key input's own key (`fundingFor`,
  `deskAuth`). An api-key share or allocation with no key of its own runs on the subscription and is recorded as such.
- **A failover is never silent.** `finishWorkSession` appends a `system` event with `alert: funding-failover` naming the
  session and what paid; the HUD shows the latest one for a day ("API key spent: …", Bank →).
- **Ops:** the `ANTHROPIC_API_KEY` Fly secret is gone from `muster-town`; the town runs on the token only. A key the town
  may spend is added at the Town Hall as a Bank input with its key, where the Bank shows it being drawn down.
- Tests: `runtime/test/secrets.test.ts`, `desk.test.ts`, `work.test.ts`, `hosted.test.ts`, `desk/test/run.test.ts`.

## Still open (proposals)

1. **Reconcile against the Console.** Once a day, read the Anthropic Admin usage/cost report for the org and compare it
   with the Bank's api-key spend for the same day; any Console spend the Bank cannot account for is a Town Hall alert.
   This is the check that would have caught this in a day instead of eight.
2. **Record the credential actually used.** The desk reports `DESK_AUTH` back; a host session should record what
   `sessionEnv` set, not what `fundingFor` planned (today the two agree by construction, which is one step short of
   evidence). The SDK's `rate_limit_event` stream (docs/token-accounting-handoff.md) only arrives on subscription
   sessions, so its absence on a session that should be subscription-funded is itself a signal.
3. **Budget in dollars** (docs/token-accounting-handoff.md): the raw-token unit made the $290 invisible inside a
   "tokens" number dominated by cache reads.

## Timeline

- 2026-10-20: subscription-first funding with API-key failover ships (939d6df, 98cdae4); the host's `ANTHROPIC_API_KEY`
  becomes the implicit fallback key.
- 2026-10-21: Secrets PR 1 (2c73766) allowlists the host env for host sessions by `CLAUDE_` / `ANTHROPIC_` prefix; the
  test codifies "both come through".
- 2026-10-22: prod moves to Fly; `.env` mirrored as Fly secrets, token and key both. First host sessions on the key.
- 2026-10-27: the API-key buffer input is cancelled in the Bank. The key stays in the env.
- 2026-10-30: Mitchell sees the Console bill, deletes the key. Host sessions start failing on it. Root cause found,
  fix and this document written, Fly secret removed, fix deployed.
