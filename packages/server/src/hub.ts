import { AppError, townRoleId, upsertGithubUser, World, type GithubProfile } from "@muster-town/core";
import { apiKeyProblem, RESERVED_SLUGS as RESERVED, slugify, slugProblem } from "@muster-town/schema";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** One hosted collective (a row of hub.db `collectives`): its own World at `<hosted>/<slug>/data/town.db`, served at `/<slug>/`. */
export interface HubCollective {
  slug: string;
  name: string;
  tagline: string;
  goal: string;
  ownerGithubId: string | null;
  createdAt: string;
  state: "active" | "retired";
}

/** Path segments a hosted collective can't take: the Workshop's own routes and the homepage's. */
export const RESERVED_SLUGS = new Set(RESERVED);

/** What the API key starts a collective with: about $20 of Opus output at list price; the admin changes it at the Bank. */
export const STARTER_KEY_TOKENS = 1_000_000;

/**
 * `POST /api/collectives`: the slug defaults to the name's (`slugify`); `apiKey` (optional, an Anthropic Console key,
 * never a subscription token) becomes the collective's own Bank input and is never returned.
 */
export const CreateCollectiveInput = z.object({
  slug: z.string().trim().optional(),
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(300),
  tagline: z.string().trim().max(200).default(""),
  apiKey: z.string().trim().max(400).optional(),
});
export type CreateCollectiveInput = z.infer<typeof CreateCollectiveInput>;

/** Builds the Fastify app that serves one hosted World under `/<slug>` (main.ts and tests pass `buildApp`). */
export type MountHosted = (world: World, row: HubCollective, dir: string) => Promise<FastifyInstance>;

interface Mounted { row: HubCollective; world: World; app: FastifyInstance }

/**
 * The hub (docs/hosted-collectives.md step 1): `hub.db` lists the hosted collectives; each active one is opened as its
 * own World and served by its own (non-listening) Fastify app, which the root app hands `/<slug>/…` requests to.
 * The Workshop is not in the hub: it is the root app itself.
 */
export class Hub {
  readonly db: Database.Database;
  private mounted = new Map<string, Mounted>();
  /** retired apps still closing (close() waits for them) */
  private closing: Promise<void>[] = [];

  constructor(readonly dir: string, private mount: MountHosted) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "hub.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS collectives (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tagline TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      ownerGithubId TEXT,
      createdAt TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired'))
    )`);
  }

  list(state?: HubCollective["state"]): HubCollective[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM collectives WHERE state = ? ORDER BY createdAt, slug").all(state)
      : this.db.prepare("SELECT * FROM collectives ORDER BY createdAt, slug").all();
    return rows as HubCollective[];
  }

  get(slug: string): HubCollective | null {
    return (this.db.prepare("SELECT * FROM collectives WHERE slug = ?").get(slug) as HubCollective | undefined) ?? null;
  }

  /** where collective `slug` keeps its collective.json, data/ and export/ */
  dirOf(slug: string): string { return join(this.dir, slug); }

  /** Open, seed and serve every active collective (boot). */
  async openAll(): Promise<void> {
    for (const row of this.list("active")) await this.open(row);
  }

  /** Active collectives a GitHub user owns (the per-person cap on `POST /api/collectives`). */
  ownedBy(githubId: number | string): HubCollective[] {
    return this.db.prepare("SELECT * FROM collectives WHERE ownerGithubId = ? AND state = 'active' ORDER BY createdAt").all(String(githubId)) as HubCollective[];
  }

  /**
   * A new collective: hub row, dir, collective.json, a seeded World, served at once (no restart); `owner` is its admin
   * and the `apiKey` (owner only) its first Bank input. The checks run before anything is written.
   */
  async create(input: CreateCollectiveInput, owner: GithubProfile | null = null): Promise<HubCollective> {
    const ownerGithubId = owner ? String(owner.id) : null;
    const i = CreateCollectiveInput.parse(input);
    const slug = i.slug || slugify(i.name);
    const bad = slugProblem(slug);
    if (bad) throw new AppError("bad_request", bad);
    if (this.get(slug)) throw new AppError("conflict", `muster.town/${slug} is taken: pick another name for the address.`);
    const apiKey = i.apiKey?.trim() || null;
    if (apiKey) {
      const why = apiKeyProblem(apiKey);
      if (why) throw new AppError("bad_request", why);
      if (!owner) throw new AppError("bad_request", "A key needs an owner: sign in with GitHub to start a collective with one.");
    }
    const row: HubCollective = { slug, name: i.name, tagline: i.tagline, goal: i.goal, ownerGithubId, createdAt: new Date().toISOString(), state: "active" };
    const dir = this.dirOf(row.slug);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "collective.json"), JSON.stringify({ name: row.name, goal: row.goal, tagline: row.tagline, buildings: [] }, null, 2) + "\n");
    this.db.prepare("INSERT INTO collectives (slug, name, tagline, goal, ownerGithubId, createdAt, state) VALUES (@slug, @name, @tagline, @goal, @ownerGithubId, @createdAt, @state)").run(row);
    await this.open(row);
    if (owner) {
      // the owner takes over the seeded "admin" placeholder under their own name (as the session does on a first visit)
      const world = this.world(row.slug)!;
      const r = upsertGithubUser(world, owner, { admins: [owner.login] });
      const user = r.linked ? world.users.upsert({ ...r.user, name: owner.name?.trim() || owner.login }) : r.user;
      world.ops.ensureAvatar(user.id);
      // stored in this collective's own database only (bank_inputs.apiKey); the API never returns it
      if (apiKey) world.bank.addInput(user.id, { label: `${owner.login}'s API key`, source: "api-key", model: "claude-opus-5-5", tokens: STARTER_KEY_TOKENS, recurrence: "once", apiKey });
    }
    return row;
  }

  /**
   * Retire a collective: its row stays (the slug is never reused), `/<slug>/` shows the retired notice from now on, and
   * its app and World close once the request that asked has been answered.
   */
  retire(slug: string): HubCollective {
    const row = this.get(slug);
    if (!row) throw new AppError("not_found", `No collective at /${slug}/.`);
    if (row.state === "retired") return row;
    this.db.prepare("UPDATE collectives SET state = 'retired' WHERE slug = ?").run(slug);
    const m = this.mounted.get(slug);
    this.mounted.delete(slug);
    if (m) this.closing.push(new Promise((r) => setTimeout(r, 50)).then(async () => { await m.app.close(); m.world.close(); }));
    return { ...row, state: "retired" };
  }

  /** The retired collective this URL names (first path segment), or null. */
  retiredAt(url: string): HubCollective | null {
    const seg = /^\/([a-z0-9-]+)(?:[/?#]|$)/.exec(url)?.[1];
    if (!seg || RESERVED_SLUGS.has(seg) || this.mounted.has(seg)) return null;
    const row = this.get(seg);
    return row?.state === "retired" ? row : null;
  }

  private async open(row: HubCollective): Promise<void> {
    if (this.mounted.has(row.slug)) return;
    const dir = this.dirOf(row.slug);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const world = World.open(join(dataDir, "town.db"));
    // own key only: the snapshot shows "No key yet" until the collective has an API key of its own
    world.host.hosted = true;
    world.seedDefaults({ adminName: "admin", townJsonPath: join(dir, "collective.json"), collectivePath: join(dir, "collective.json"), dataDir });
    world.start(10);
    // the owner is this World's admin, also after a reopen (a first visit makes their user if there is none yet)
    const owner = row.ownerGithubId != null ? world.users.first("githubId = ?", [Number(row.ownerGithubId)]) : null;
    if (owner) world.permissions.grant({ kind: "user", id: owner.id }, townRoleId("admin"));
    const app = await this.mount(world, row, dir);
    await app.ready();
    this.mounted.set(row.slug, { row, world, app });
  }

  /** The app serving this URL's collective (first path segment), or null: the Workshop's. */
  match(url: string): FastifyInstance | null {
    const seg = /^\/([^/?#]+)/.exec(url)?.[1];
    return seg ? this.mounted.get(seg)?.app ?? null : null;
  }

  world(slug: string): World | null { return this.mounted.get(slug)?.world ?? null; }
  get count(): number { return this.mounted.size; }

  async close(): Promise<void> {
    if (!this.db.open) return;
    await Promise.all(this.closing);
    for (const m of this.mounted.values()) { await m.app.close(); m.world.close(); }
    this.mounted.clear();
    this.db.close();
  }
}
