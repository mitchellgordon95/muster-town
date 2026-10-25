# Secrets

Two tiers (design: town docs dc_ios62uyco3 and dc_8hdfo4rucp). Ask: if this leaked, whose blast radius is it?

- **Host secrets** (the whole server, every collective, the box): `GITHUB_CLIENT_ID/SECRET`, the session secret, the admin token, `MUSTER_TOWN_DATA_KEY`, deploy/infra tokens, the server's own model login. The operator sets them in the server's env (`collectives/<id>/.env` on localhost, `/etc/muster-town/env` on the VPS). They never show in the UI and **never reach a desk**.
- **Collective secrets** (one collective's tools, repo or research APIs, e.g. `MINICLAW_WS_TOKEN`): managed by the collective's admins at the Town Hall (the **Secrets** tab of the planning desk; it was a tab of the Town Hall building panel until 2026-10-24), stored encrypted in the `secrets` table, and granted to the whole town (every resident), or per building, agent or skill.

## Storage

`secrets (name, ciphertext, grants, updatedAt, updatedBy)` (migration 027). `ciphertext` is `v1:` + base64(iv[12] | GCM tag[16] | AES-256-GCM ciphertext) under the host's `MUSTER_TOWN_DATA_KEY` (32 bytes, base64 or 64 hex chars; make one with `openssl rand -base64 32`), with the secret's name as AAD. The key is never in the DB. Without it the server refuses to store values (HTTP 409) and passes no secrets to desks: nothing is ever stored in plaintext. Losing the key makes the stored values unreadable: set them again.

Names are env-var style (`A-Z0-9_`, starting with a letter). Names the runtime sets itself are reserved: `MUSTER_TOWN_*`, `AGENT_TOWN_*`, `DESK_*`, `CLAUDE_*`, `ANTHROPIC_*`, `GH_*`, `GITHUB_*`, `NODE_*`, `LD_*`, `DYLD_*`, `PATH`, `HOME` and other process basics.

**The repo token is the exception.** A collective secret named `GH_TOKEN` is the GitHub token for the collective's own repo (`workspace` in collective.json): a fine-grained token for that repo with Contents and Pull requests read/write. It is the one `GH_*` name the Town Hall accepts. Grants don't apply to it: every desk with code access gets it as `GH_TOKEN` (the repo is the collective's, and code access is the grant), and the town's own `redeploy` pulls with it (`Secrets.value`, read by the runtime; never logged). When the collective has none, the host fallback applies: `desks.ghToken` = `gh-cli` (`gh auth token` on the host), `env` (the host's `GH_TOKEN`), or `none`. The server warns at boot when a collective has a repo but no token from either source.

## API (collective admins: a human's user token or session; agent tokens get 403)

- `GET /api/secrets` → `{secrets: [{name, grants: {buildings, agents, skills}, set, updatedAt, updatedBy}], keyConfigured}`. Never values.
- `PUT /api/secrets/:name {value?, grants?}`: create, replace the value (write-only) and/or replace the grants (`{town?: boolean, buildings, agents, skills}`; `town: true` = every resident, the other lists then add nothing). Grants must name existing buildings, agents and skill docs. Events `secret.set` (no value).
- `DELETE /api/secrets/:name` → `{removed}`. Event `secret.deleted`.

## Desks

`deskEnv()` (`runtime/src/desk/session.ts`, `grantedSecrets`) passes a secret as `NAME` only when it has a value and is granted to the session's home building, its agent, or a skill that loads into the agent's sessions (`skills.forAgent`: agent, building or town pins). Each one appends `secret.granted {name, sessionId, via}` without the value.

Nothing comes from the host env: the `DESK_ENV_<NAME>` fallback (one release, 2026-10-21 to 2026-10-25) is gone. A tool credential a desk needs is a Town Hall secret with a grant, or it does not reach the desk.

A skill grant reaches every agent the skill is pinned for: a town-wide pin means every resident. To narrow it, pin the skill per building or agent, or grant the secret to buildings/agents instead.

## Host sessions and the admin token

Host-backend sessions (summaries, meetings, in-process work) get an allowlisted env (`runtime/src/sdk.ts`, `sessionEnv`: `PATH`, `HOME`, locale, proxies, CA certs, `CLAUDE_*`, `ANTHROPIC_*`), not `{...process.env}`. The admin token is written to `<data>/admin-token` (0600) and startup prints only its path.
