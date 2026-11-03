# Prompt caching: what goes where in a session's prompt

Status: the rule, since 2026-11-02 (Mitchell's Claude Code session with Mitchell, from the overdraft investigation).
The measurement that motivated it is at the end. The invariant tests are in `packages/core/test/prompts.test.ts`
("the team-lead prompt is split for the provider's cache") and `packages/runtime/test/manage.test.ts`.

## The rule

The provider caches a request's prefix: tools, then the system prompt, then the messages, matched byte for byte up
to the cache breakpoints the SDK sets (the end of the tools block, the end of the system prompt, the last messages).
A session pays the cache-write price for every token of that prefix it is the first to send in an hour, and the
cache-read price (a fortieth of input, a hundredth of output) for every token that matches a prefix sent before.

So a prompt is laid out in three layers, by how often its text changes:

1. **The system prompt holds only what is the same from one session to the next.** Identity, the world rules, the
   report format, the building's standing rules, pinned skills, the in-tray rules (how to decide, how to roll up).
   No clock, no in-tray rows, no team or queue, no grants, no board, no wiki or log, no commit hash.
2. **The first user message holds what is live now**, in one block: the server's clock first (standing rule 5), then
   the state. A manager's team-lead session gets `managerStateBlock` (`packages/core/src/prompts.ts`): in-tray rows and
   their status line, the team and queue, the grants, the town board, the *index* of its wiki (title, id, gist) and
   the last lines of its log, then the code snapshot's commit, then the task (`managePrompt`, a 1:1, a resume).
   A work session's `workPrompt` opens with the clock, then the assignment.
3. **Big or fast-changing state is read on demand** with `read`: wiki pages, reports, topic pages. The manager
   rewrites its wiki at the end of every wake, so a page in the prompt is a page that misses the cache every time.

A manager's team-lead session is sent **without the Claude Code preset** (`SessionSpec.bare`,
`packages/runtime/src/session.ts`): the preset's own guidance sections land in the same cache block as the appended
town prompt and were a third of what every wake re-wrote; a manager decides and talks, it edits no code. Work sessions
keep the preset (they use the built-in tools on a desk).

Adding something to a prompt? Ask which layer it belongs to. If it carries a time, a count, an id of today's work or
anything an agent changes during a session, it is layer 2 or 3, never layer 1. `workSystemPrompt` and
`managerSystemPrompt` take no `now`.

## How to check it on a live session

A host session's transcript (`GET /api/sessions/:id/transcript`, admins) is the SDK's JSONL. Its first `assistant`
record's `message.usage` says what the prefix cost:

- `cache_read_input_tokens`: the part of the prefix that matched a cached one (the tool block and, when the layout
  holds, the system prompt).
- `cache_creation_input_tokens` with `cache_creation.ephemeral_1h_input_tokens`: the part written fresh.

On a manager wake that follows another within the hour, the system prompt should be in the read figure and the
written figure should be about the size of the first message (a few thousand tokens). A written figure in the tens
of thousands on every wake means the layout is broken again: something in the system prompt changes per session.

The Bank's `mix` (`GET /api/finance`, "1 adj. token ≈ N raw tokens") shows the town-wide shares by kind; cache writes
above about a third of cost is the same symptom at the aggregate level.

## The measurement (2026-11-02)

Session se_x01viep8at, Pix's team-lead wake at 18:37 UTC, Fable 5.1, 6 turns, 44.7K adjusted tokens ($0.89):

| Kind | Raw tokens | Adjusted | Share |
|---|---|---|---|
| 1-hour cache write (the appended system prompt + first message) | 31.9K | 31.9K | 71% |
| Output | 3.4K | 8.5K | 19% |
| 5-minute cache writes (the turns) | 4.4K | 2.7K | 6% |
| Cache reads (131K raw over 6 turns) | 131K | 1.6K | 4% |

The first turn read 22.2K tokens from cache (the preset's tool schemas and the 32 town verbs: identical every
session) and wrote 31.9K: the whole appended block, because its second line was the clock. Of those 31.9K, about 9K
was the manager's wiki, 10K the Claude Code preset's sections, 3K the building's topic index, 2K the log, under 2K
each for the grants, in-tray, team and opener. The reports being decided were 5%.

71 Fable manager wakes between 02:44 and 19:00 UTC that day cost 3.89M adjusted tokens. At the same raw counts with
the prefix hitting the cache: 2.03M. With the wiki and preset out of the prefix as well, a wake is about 13K, a
fourth of what it was. Desk work sessions were measured too: their prefix is under a tenth of a session's cost (a
50-turn session reads a 100K+ context every turn, and that dominates), so they only get the clock moved into the
first message; the rest of their system prompt stays.
