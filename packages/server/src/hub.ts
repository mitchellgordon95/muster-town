import { AppError, World } from "@muster-town/core";
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
export const RESERVED_SLUGS = new Set(["workshop", "api", "auth", "ws", "mcp", "media", "next", "skill.md", "hosted", "assets", "home"]);

export const CreateCollectiveInput = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "lowercase letters, digits and dashes (2 to 40, no dash at either end)").min(2),
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(300),
  tagline: z.string().trim().max(200).default(""),
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

  /** A new collective: hub row, dir, collective.json, a seeded World, served at once (no restart). */
  async create(input: CreateCollectiveInput, ownerGithubId: string | null = null): Promise<HubCollective> {
    const i = CreateCollectiveInput.parse(input);
    if (RESERVED_SLUGS.has(i.slug)) throw new AppError("bad_request", `"${i.slug}" is reserved: pick another name for the address.`);
    if (this.get(i.slug)) throw new AppError("conflict", `muster.town/${i.slug} is taken: pick another name for the address.`);
    const row: HubCollective = { slug: i.slug, name: i.name, tagline: i.tagline, goal: i.goal, ownerGithubId, createdAt: new Date().toISOString(), state: "active" };
    const dir = this.dirOf(row.slug);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "collective.json"), JSON.stringify({ name: row.name, goal: row.goal, tagline: row.tagline, buildings: [] }, null, 2) + "\n");
    this.db.prepare("INSERT INTO collectives (slug, name, tagline, goal, ownerGithubId, createdAt, state) VALUES (@slug, @name, @tagline, @goal, @ownerGithubId, @createdAt, @state)").run(row);
    await this.open(row);
    return row;
  }

  private async open(row: HubCollective): Promise<void> {
    if (this.mounted.has(row.slug)) return;
    const dir = this.dirOf(row.slug);
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const world = World.open(join(dataDir, "town.db"));
    world.seedDefaults({ adminName: "admin", townJsonPath: join(dir, "collective.json"), collectivePath: join(dir, "collective.json"), dataDir });
    world.start(10);
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
    for (const m of this.mounted.values()) { await m.app.close(); m.world.close(); }
    this.mounted.clear();
    this.db.close();
  }
}
