/**
 * Collective secrets (docs/secrets.md): tool credentials a collective's admin manages at the Town Hall. Values are
 * encrypted with AES-256-GCM under the host's data key (MUSTER_TOWN_DATA_KEY, never stored in the DB) and are
 * write-only through the API: `list` returns names, grants and set/missing. A desk session gets a secret only when it
 * is granted to the session's building or agent, or to a skill pinned for that agent (`forAgent`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretGrants, SecretName, townEnv, type SecretView } from "@muster-town/schema";
import { homeOf } from "./domain.ts";
import { AppError, badRequest } from "./errors.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** Names the runtime sets itself (town, desk, model and GitHub credentials, process basics): never a collective secret. */
const RESERVED = /^(MUSTER_TOWN_|AGENT_TOWN_|DESK_|CLAUDE_|ANTHROPIC_|GH_|GITHUB_|NODE_|LD_|DYLD_)|^(PATH|HOME|USER|SHELL|TERM|LANG|TZ|TMPDIR)$/;
/**
 * The one `GH_*` name a collective may set: the GitHub token for the collective's own repo (docs/secrets.md). Every desk
 * with code access gets it (the repo is the collective's; grants don't apply), and the town's `redeploy` pulls with it.
 */
export const REPO_TOKEN_SECRET = "GH_TOKEN";

const NO_KEY = "Secret values can't be stored: the host has no MUSTER_TOWN_DATA_KEY (32 bytes, base64 or hex; e.g. `openssl rand -base64 32`). The operator sets it in the server's env. Values are never stored in plaintext.";

/** The host data key from `MUSTER_TOWN_DATA_KEY`: 32 bytes as 64 hex chars or base64. null when unset; throws when malformed. */
export function dataKeyFrom(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new AppError("bad_request", "MUSTER_TOWN_DATA_KEY must be 32 bytes (64 hex chars, or base64 of 32 bytes).");
  return key;
}

/** `v1:` + base64(iv[12] | tag[16] | ciphertext). The name is the AAD, so a value can't be moved to another name. */
export function encryptSecret(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(name));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptSecret(key: Buffer, name: string, blob: string): string {
  if (!blob.startsWith("v1:")) throw new Error("unknown secret format");
  const raw = Buffer.from(blob.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

interface Row { name: string; ciphertext: string | null; grants: string; updatedAt: string; updatedBy: string | null }

export class Secrets {
  /** `dataKey` reads the host key each call (default: MUSTER_TOWN_DATA_KEY from the env). */
  constructor(private world: World, private dataKey: () => string | undefined = () => townEnv("DATA_KEY")) {}

  /** Whether the host has a usable data key (the panel says so when it doesn't). */
  keyConfigured(): boolean {
    try { return !!dataKeyFrom(this.dataKey()); } catch { return false; }
  }

  private key(): Buffer {
    const k = dataKeyFrom(this.dataKey());
    if (!k) throw new AppError("conflict", NO_KEY);
    return k;
  }

  private rows(): Row[] {
    return this.world.db.prepare("SELECT * FROM secrets ORDER BY name").all() as Row[];
  }

  private row(name: string): Row | undefined {
    return this.world.db.prepare("SELECT * FROM secrets WHERE name = ?").get(name) as Row | undefined;
  }

  private view(r: Row): SecretView {
    return { name: r.name, grants: SecretGrants.parse(JSON.parse(r.grants)), set: !!r.ciphertext, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  }

  list(): SecretView[] {
    return this.rows().map((r) => this.view(r));
  }

  get(name: string): SecretView | null {
    const r = this.row(name);
    return r ? this.view(r) : null;
  }

  /** Validate a name for a new secret: env-var style and not one the runtime sets itself. */
  checkName(name: string): string {
    const r = SecretName.safeParse(name);
    if (!r.success) throw badRequest(`Secret name "${name}": ${r.error.issues[0]?.message ?? "invalid"}.`);
    if (name !== REPO_TOKEN_SECRET && RESERVED.test(name)) throw badRequest(`"${name}" is reserved: the runtime sets it (town, desk, model or GitHub credentials). Pick another name.`);
    return name;
  }

  /**
   * The decrypted value of one secret, for the runtime's own use (the collective's repo token). null when unset, or
   * when it can't be decrypted (no data key, or another host's), with a warning. Never log the result.
   */
  value(name: string): string | null {
    const r = this.row(name);
    if (!r?.ciphertext) return null;
    try {
      return decryptSecret(this.key(), name, r.ciphertext);
    } catch (e) {
      console.warn(`[secrets] ${name} unusable: ${e instanceof AppError ? "no MUSTER_TOWN_DATA_KEY on the host" : "it doesn't decrypt with the host's data key"}`);
      return null;
    }
  }

  /**
   * Create or update a secret: replace its value (encrypted; refused without a data key) and/or its grants. Grants must
   * name existing buildings, agents and skills. `by` is the user id, kept for the audit line. Never logs the value.
   */
  put(name: string, input: { value?: string; grants?: SecretGrants }, by: string | null): SecretView {
    this.checkName(name);
    const cur = this.row(name);
    let grants = cur ? SecretGrants.parse(JSON.parse(cur.grants)) : SecretGrants.parse({});
    if (input.grants) grants = this.checkGrants(input.grants);
    const ciphertext = input.value !== undefined ? encryptSecret(this.key(), name, input.value) : cur?.ciphertext ?? null;
    this.world.db.prepare(
      "INSERT INTO secrets (name, ciphertext, grants, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, grants = excluded.grants, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy",
    ).run(name, ciphertext, JSON.stringify(grants), nowIso(), by);
    const changed = [input.value !== undefined ? "value" : null, input.grants ? "grants" : null].filter(Boolean).join(" and ") || "nothing";
    this.world.events.append({ type: "secret.set", text: `Secret ${name}: ${changed} updated`, payload: { name, by, value: input.value !== undefined, grants } });
    return this.view(this.row(name)!);
  }

  delete(name: string, by: string | null): { removed: boolean } {
    const removed = this.world.db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes > 0;
    if (removed) this.world.events.append({ type: "secret.deleted", text: `Secret ${name} deleted`, payload: { name, by } });
    return { removed };
  }

  private checkGrants(g: SecretGrants): SecretGrants {
    const uniq = (xs: string[]) => [...new Set(xs)];
    const out = { buildings: uniq(g.buildings), agents: uniq(g.agents), skills: uniq(g.skills) };
    for (const id of out.buildings) if (!this.world.buildings.get(id)) throw badRequest(`No building ${id}.`);
    for (const id of out.agents) if (!this.world.agents.get(id)) throw badRequest(`No agent ${id}.`);
    for (const id of out.skills) if (this.world.docs.get(id)?.type !== "skill") throw badRequest(`No skill ${id}.`);
    return out;
  }

  /**
   * Secrets granted to a session of `agentId`: its home building or itself, or a skill that loads into its sessions.
   * Only secrets with a value; without a data key (or on a value that won't decrypt) the secret is skipped with a
   * warning, never passed garbled. Values are secrets: callers must never log them.
   */
  forAgent(agentId: string): { name: string; value: string; via: "building" | "agent" | "skill" }[] {
    const agent = this.world.agents.get(agentId);
    if (!agent) return [];
    const bid = homeOf(agent);
    let skillIds: Set<string> | null = null;
    const out: { name: string; value: string; via: "building" | "agent" | "skill" }[] = [];
    for (const r of this.rows()) {
      if (!r.ciphertext) continue;
      const g = SecretGrants.parse(JSON.parse(r.grants));
      let via: "building" | "agent" | "skill" | null = bid && g.buildings.includes(bid) ? "building" : g.agents.includes(agent.id) ? "agent" : null;
      if (!via && g.skills.length) {
        skillIds ??= new Set(this.world.skills.forAgent(agent.id).map((s) => s.doc.id));
        if (g.skills.some((id) => skillIds!.has(id))) via = "skill";
      }
      if (!via) continue;
      try {
        out.push({ name: r.name, value: decryptSecret(this.key(), r.name, r.ciphertext), via });
      } catch (e) {
        console.warn(`[secrets] ${r.name} not passed to ${agent.name}: ${e instanceof AppError ? "no MUSTER_TOWN_DATA_KEY on the host" : "it doesn't decrypt with the host's data key"}`);
      }
    }
    return out;
  }
}
