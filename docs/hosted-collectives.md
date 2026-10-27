# Hosted collectives: muster.town/<name>

Status 2026-10-27: grant gr_rdyrjzclfe (key result kr_7316be4jqw, Onboarding) was approved by Mitchell in the Town Hall
meeting of 2026-10-27 17:21Z (mt_6830h8x5qk, decision 6) and waits for the Fund press. Terms set in that meeting:

- Anyone signed in with GitHub may start a collective (no Let in first).
- **Each hosted collective brings its own Claude credential and never spends the host's.** Fly compute is floated
  by Mitchell for now.
- Before any build that uses Claude subscription OAuth as a key source: the findings in the last section.

## The plan (four PRs, in order)

1. **Hub.** One process hosts many collectives: a hub table (slug, name, owner, created, state) replaces
   `collectives/registry.json` as the homepage list; each collective is its own World at `/data/<slug>/data/town.db`
   with routes, ws and mcp mounted under `/<slug>/` (one Fastify plugin per prefix with its own `app.world`).
   `/workshop/` stays; the root `/api`, `/ws`, `/mcp` keep pointing at the Workshop. The web client reads its base from
   the URL at runtime. Fallback if too invasive: one child process per collective behind the hub as a reverse proxy.
   Done 2026-10-27 (667c72b): one process, each hosted app dispatched from the root's first hook (not plugins).
2. **One sign-in.** GitHub OAuth stays at the root (one callback), root-scoped cookie, a hub users table; a
   collective's user row is linked by githubId on first visit, visitor-until-let-in per collective, the creator is admin.
   Done 2026-10-27, without a hub users table: the root's session cookie carries the GitHub identity (`gh`) and its
   secret is shared by every hosted app, which finds or makes its own user by githubId on the first request (town
   `visitor`: read-only, Ask to join). The hub row's owner holds `admin` in their World (granted at creation and at
   every reopen; the owner takes over the seeded "admin" placeholder). Sign in at `/<slug>/` goes through the root's
   flow with a checked return-to (`safeReturnTo`: same host, an active slug's path) and lands back there. A Workshop
   admin is a guest in a hosted collective. Tests: `packages/server/test/hub-auth.test.ts`.
3. **Start a collective.** The form on the homepage (below) and `POST /api/collectives`.
4. **Live check** with a second GitHub account in a private window; manual section "Start your own collective";
   README points hosted users to the homepage.

## Step 3: Start a collective, and the own-key requirement

The form (paper style, see the `muster-style-guide` skill): **Name**, **Goal**, **Tagline** (slug from the name), and
one more block, **Your agents run on your key**:

- An **Anthropic API key** field (a Console key, `sk-ant-api…`). Optional at creation so the 5-minute key result
  holds and the founder can look around first, but nothing runs without it: the collective's agents stay held with the
  notice "No key yet: add your Anthropic API key at the Bank" until the admin adds one.
- The key is stored as the collective's own Bank input (source `api-key`, `POST /<slug>/api/bank/inputs`), in that
  collective's database, the same way the Bank stores API-key inputs today. It is never returned by the API and never
  logged.
- The copy on the form says, in this order: your agents run on your Anthropic API key, billed to you by Anthropic;
  Muster Town never spends its own; a Max or Team plan includes monthly API credits you can use here (link a Console
  organization in claude.ai billing settings, create a key there, paste it); the key can be rotated or removed at the Bank.
- The form **does not** accept Claude subscription tokens (`CLAUDE_CODE_OAUTH_TOKEN`, anything from `claude
  setup-token` or `/login`) and says so in one line: Anthropic does not let a third party collect or store Claude.ai
  credentials. The Workshop's own subscription token stays in the host env and funds the Workshop only.

What the server enforces (step 1 and 3, with tests):

- A hosted World runs with an **empty credential env**: `fundingFor` (packages/runtime/src/session.ts) must see
  no `ANTHROPIC_API_KEY`, no `CLAUDE_CODE_OAUTH_TOKEN` and no fallback key for a hosted World, so every `envKey`
  fallback there is null and `world.bank.fallbackInput` only finds that collective's own inputs. A session whose
  funding resolves to `auth: null` or `apiKey: null` in a hosted World is not started: the agent is held with the
  notice above (today `sessionEnv` would fall through to "none (the CLI's own login, if any)", which on the Fly host
  is the Workshop's login; that path must be closed for hosted Worlds).
- Test: a hosted World created while the host env carries both credentials never passes either value to a desk, and
  its first session after the admin adds a key runs with `DESK_AUTH=api-key` and that key.
- The subscription allocation kinds (`subscription` in `AllocationAuth`, "My subscription (owner)" at the Bank) are
  not offered in a hosted collective: only `api-key` and `donor-key` inputs.
- `GET /<slug>/api/health` and the Bank page show "funded by API key" or "no key" for the collective, never the host's
  funding.

## Claude credentials for hosted collectives: what Anthropic allows (checked 2026-10-27)

Primary sources, all read on 2026-10-27:

- Claude Code legal and compliance page: https://code.claude.com/docs/en/legal-and-compliance
- Claude Code authentication page (`claude setup-token`, precedence): https://code.claude.com/docs/en/authentication
- Agent SDK overview (the note on third-party login): https://code.claude.com/docs/en/agent-sdk/overview
- Help center, "Use the Claude Agent SDK with your Claude plan" (updates of 2026-06-15 and 2026-10-07):
  https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Help center, "Monthly API credits for Max and Team plans" (2026-10-07):
  https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans

What the sources say:

1. OAuth login "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription
   plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
2. "Developers building products or services that interact with Claude's capabilities, including those using the
   Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does
   not permit third-party developers to offer Claude.ai login into their own applications, or to route requests
   through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store,
   or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through
   Anthropic's own flow." The Agent SDK page repeats it: "Unless previously approved, Anthropic does not allow third
   party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude
   Agent SDK."
3. Hosted platforms: "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or
   other agent infrastructure) requires agreeing to our Commercial Terms of Service" and: the binary must be
   unmodified with every built-in sign-in method left in; "Each end user must authenticate with their own Anthropic
   API key, Claude subscription plan credentials, or 3P inference provider credential"; usage "is billed directly to
   the end user under their own agreement with Anthropic". The credential rules do not "prevent an end user from
   signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform
   hosts Claude Code".
4. `claude setup-token` mints a one-year OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) for "CI pipelines, scripts, or other
   environments where interactive browser login isn't available"; it "requires a Pro, Max, Team, or Enterprise plan"
   and "can only make model requests". The docs present it as the user's own credential for the user's own pipelines.
5. Billing today: the Agent SDK and `claude -p` signed in with a plan still draw from the plan's usage limits (the
   June 2026 change was paused). Since 2026-10-07 Max and Team plans include monthly API credits (Max 5x $100, Max
   20x $200, Team $20 per Standard and $100 per Premium seat pooled, capped at $500; figures from the help-center
   article) usable through an API key from a Console organization linked in claude.ai billing settings; they cover the
   Claude API and the Agent SDK, not interactive Claude Code, expire each cycle and are never charged to the plan.

What this means for muster.town (my reading, not Anthropic's):

- Muster Town's desks are the Agent SDK (`packages/desk/src/run.ts` calls `query()`), driven by the town's scheduler,
  not by the subscriber at a terminal. A hosted collective on muster.town is a "product or service" built on the
  Agent SDK and made available to other people, so clause 2 applies: **API keys are the sanctioned key source.** A
  form field or Bank input that takes a `CLAUDE_CODE_OAUTH_TOKEN` from a stranger is collecting and storing a Claude.ai
  credential, which clause 2 forbids regardless of how we store it. The Workshop's own token in the host env is
  Mitchell's own credential for his own collective; that is the "ordinary use" case and stays as it is.
- The only subscription path Anthropic describes (clause 3) is the end user signing in through Anthropic's own flow
  inside an unmodified Claude Code binary that the platform hosts: the founder opens a shell in their collective's
  desk container and runs `claude auth login` (the code-paste flow works without a local browser), the credential
  lands in that container's `~/.claude/.credentials.json`, and the town's desks run with that config dir. What it
  would take: a persistent per-collective desk volume (today's Fly desks are recreated idle), a web terminal or
  `fly ssh` instructions for the founder, `CLAUDE_CONFIG_DIR` plumbing in the runtime, and a legal read on whether an
  autonomous scheduler starting sessions under that login is still the subscriber's "ordinary, individual usage"; the
  advertised limits assume that, and the pause of June 2026 can be lifted any time. I would not build this without
  Anthropic saying yes in writing (the legal page offers contact sales for exactly this question).
- The cheap sanctioned way to let a subscriber pay with their subscription is clause 5: a Max or Team subscriber links
  a Console organization, creates an API key there, and pastes that key into the Start form; the monthly API credit
  pays for the collective's sessions and Anthropic bills nothing beyond it unless the Console org has its own credits.
  That costs us one sentence of copy on the form and nothing in code beyond the API-key path already in the Bank.

Decision this document proposes: hosted collectives are API-key only; the form says how a Max or Team plan's credits
fund one; no OAuth token field. Anthropic's permission (contact sales) is the precondition for any subscription-login
path, and nobody builds one until a human has it.
