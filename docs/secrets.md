# Secrets

Two tiers (design: town docs dc_ios62uyco3 and dc_8hdfo4rucp). Ask: if this leaked, whose blast radius is it?

- **Host secrets** (the whole server, every collective, the box): `GITHUB_CLIENT_ID/SECRET`, the session secret, the admin token, `MUSTER_TOWN_DATA_KEY`, deploy/infra tokens (e.g. `FLY_DESKS_ACCESS_TOKEN`, the muster-desks deploy token the redeploy pushes the desk image with; the redeploy also takes it from a collective secret of that name, and then it reaches whichever desks it is granted to), the server's own model login. The operator sets them in the server's env (`collectives/<id>/.env` on localhost, `/etc/muster-town/env` on the VPS). They never show in the UI and **never reach a desk**.
- **Collective secrets** (one collective's tools, repo or research APIs, e.g. `MINICLAW_WS_TOKEN`): managed by the collective's admins at the Town Hall (the **Secrets** tab of the planning desk; it was a tab of the Town Hall building panel until 2026-10-24), stored encrypted in the `secrets` table, and granted to the whole town (every resident), or per building, agent or skill.

## The backup key

`MUSTER_TOWN_BACKUP_KEY` is a host secret: the 32-byte key (base64, `openssl rand -base64 32`) the server's nightly off-site backup
(`packages/server/src/backup/`, deploy/README.md "Backups") encrypts each copy of `town.db` with (AES-256-GCM, the storage scheme
below applied to the whole file: iv[12] | tag[16] | ciphertext, AAD `muster-town backup v1`). The copies leave the Machine, and the DB
holds every token in plaintext (`tokens` table), so the key must not be the data key and must not live on the volume: **Mitchell
generates it, keeps it in his password manager ("muster-town backup key") and sets it with `fly secrets set MUSTER_TOWN_BACKUP_KEY=... -a
muster-town`.** The key is never in the DB, never on `/api/health`, never on a desk. Losing it makes every off-site copy unreadable; the
bucket credentials (`BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, set by `fly storage create`) are
host secrets too. Without all five the backup is off (health shows `backup: null`, one boot warning).

## Storage

`secrets (name, ciphertext, grants, updatedAt, updatedBy)` (migration 027). `ciphertext` is `v1:` + base64(iv[12] | GCM tag[16] | AES-256-GCM ciphertext) under the host's `MUSTER_TOWN_DATA_KEY` (32 bytes, base64 or 64 hex chars; make one with `openssl rand -base64 32`), with the secret's name as AAD. The key is never in the DB. Without it the server refuses to store values (HTTP 409) and passes no secrets to desks: nothing is ever stored in plaintext. Losing the key makes the stored values unreadable: set them again.

Names are env-var style (`A-Z0-9_`, starting with a letter). Names the runtime sets itself are reserved: `MUSTER_TOWN_*`, `AGENT_TOWN_*`, `DESK_*`, `CLAUDE_*`, `ANTHROPIC_*`, `GH_*`, `GITHUB_*`, `NODE_*`, `LD_*`, `DYLD_*`, `PATH`, `HOME` and other process basics.

**The repo token is the exception.** A collective secret named `GH_TOKEN` is the GitHub token for the collective's own repo (`workspace` in collective.json): a fine-grained token for that repo with Contents and Pull requests read/write. It is the one `GH_*` name the Town Hall accepts. Grants don't apply to it: every desk with code access gets it as `GH_TOKEN` (the repo is the collective's, and code access is the grant), and the town's own `redeploy` pulls with it (`Secrets.value`, read by the runtime; never logged). When the collective has none, the host fallback applies: `desks.ghToken` = `gh-cli` (`gh auth token` on the host), `env` (the host's `GH_TOKEN`), or `none`. The server warns at boot when a collective has a repo but no token from either source.

## Bank secrets at rest

The Bank's credentials (`bank_inputs.apiKey`: an api-key input's key or a subscription input's OAuth token) and donors' keys (`users.apiKey`) are stored as the same `v1:` AES-256-GCM ciphertext under `MUSTER_TOWN_DATA_KEY`, with AAD `bank_inputs:<id>` / `users:<id>` so a value can't be moved to another row. `Users` and `BankInputs` in `packages/core/src/store.ts` are the only code that reads or writes the column (`setApiKey` encrypts, `getApiKey` decrypts); the Bank and `fundingFor` see plaintext only through them. At boot the server encrypts any plaintext rows in place (`[secrets] encrypted N bank inputs, M donor keys`; idempotent; hosted collectives too). A copy of town.db opened under another key (a drill town) reads these secrets as null, with one `[secrets] bank input <id> unusable` warning per row, so it can't spend the Bank's credentials. A self-hosted town without a data key keeps them in plaintext, with a warning, so its Bank still runs; setting a key encrypts them at the next boot.

## Login tokens

Login tokens (`tokens`: a browser's sign-in, the CLI's, an agent's) are stored as `sha256:<hex>` of the token, never the token (gr_6qlj35wnh3 step 3). The token is random (`at_` + 32 nanoid chars), so an unsalted hash is enough. `Tokens` in `packages/core/src/store.ts` is the only code that touches the table: `create` returns the plaintext once to whoever it is for and stores the hash; `resolve` hashes what it is shown. `openDb` hashes any plaintext row in place after the migrations (`[secrets] hashed N plaintext login tokens in place`; idempotent), and a plaintext row it hasn't reached still resolves once and is hashed then, so the change logs nobody out: a browser's cookie, the CLI and a running desk keep their tokens. A stored hash shown as a token never matches.

**Agents get a token per session.** A hashed row can't be handed out again, so a desk session (`deskEnv`) and a host session (`townOptions`) each get their own token (`tokens.sessionId`, migration 079), revoked when the session ends (`ops.endSession`). Tokens issued before this change (one per agent, no session) keep working; retiring or dismissing an agent revokes all of its tokens as before.

**The admin token** has `<data>/admin-token` as its source: at boot its hash is put in the table if missing, so the same token keeps working; with no file (a restored or recovered town: the file isn't in a copy) the server issues a new one and writes the file.

**What a leaked copy of town.db gives:** hashes, which no endpoint accepts. A drill or recover town still answers to the live tokens' holders while it runs (it holds the same hashes), but whoever has the copy can't read a login out of it. Copies taken before the deploy of this change hold plaintext rows until retention deletes them (30 daily copies).

## API (collective admins: a human's user token or session; agent tokens get 403)

- `GET /api/secrets` → `{secrets: [{name, grants: {buildings, agents, skills}, set, updatedAt, updatedBy}], keyConfigured}`. Never values.
- `PUT /api/secrets/:name {value?, grants?}`: create, replace the value (write-only) and/or replace the grants (`{town?: boolean, buildings, agents, skills}`; `town: true` = every resident, the other lists then add nothing). Grants must name existing buildings, agents and skill docs. Events `secret.set` (no value).
- `DELETE /api/secrets/:name` → `{removed}`. Event `secret.deleted`.

## Desks

`deskEnv()` (`runtime/src/desk/session.ts`, `grantedSecrets`) passes a secret as `NAME` only when it has a value and is granted to the session's home building, its agent, or a skill that loads into the agent's sessions (`skills.forAgent`: agent, building or town pins). Each one appends `secret.granted {name, sessionId, via}` without the value.

Nothing comes from the host env: the `DESK_ENV_<NAME>` fallback (one release, 2026-10-21 to 2026-10-25) is gone. A tool credential a desk needs is a Town Hall secret with a grant, or it does not reach the desk.

A skill grant reaches every agent the skill is pinned for: a town-wide pin means every resident. To narrow it, pin the skill per building or agent, or grant the secret to buildings/agents instead.

## Host sessions and the admin token

Host-backend sessions (summaries, meetings, in-process work) get an allowlisted env (`runtime/src/sdk.ts`, `sessionEnv`: `PATH`, `HOME`, locale, proxies, CA certs, `CLAUDE_*`, `ANTHROPIC_*`), not `{...process.env}`. The admin token is written to `<data>/admin-token` (0600) and startup prints only its path (see "Login tokens").
