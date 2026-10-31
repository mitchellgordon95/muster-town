/**
 * Process entry: open the world, seed if empty, start the tick, the HTTP/WS/MCP server, and the runtime.
 * Env (MUSTER_TOWN_<X>, or the old AGENT_TOWN_<X>): COLLECTIVE (collectives/workshop), DATA (<collective>/data),
 * EXPORT (<collective>/export), DEV, ADMIN_NAME. Plain PORT (collective.json port or 4321) and HOST (0.0.0.0).
 */
import { World } from "@muster-town/core";
import { assertNoEnvCredentials } from "@muster-town/runtime";
import { townEnv } from "@muster-town/schema";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { BackupJob } from "./backup/index.ts";
import { loadAuthSettings } from "./auth/index.ts";
import { Hub } from "./hub.ts";
import { Directory, directoryEnabled } from "./directory/index.ts";
import { Counters, defaultMetrics, Monitor, processProbes } from "./monitor.ts";
import { desksFromEnv, loadEnvFile } from "./env.ts";
import type { RuntimeHooks } from "./context.ts";
import type { FastifyInstance } from "fastify";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** A collective = one instance of the town: <dir>/collective.json + <dir>/data + <dir>/export. */
const COLLECTIVE_DIR = resolve(REPO_ROOT, townEnv("COLLECTIVE") ?? "collectives/workshop");
const COLLECTIVE_JSON = join(COLLECTIVE_DIR, "collective.json");

const envKeys = loadEnvFile(join(COLLECTIVE_DIR, ".env"));
if (envKeys.length) console.log(`[server] loaded ${envKeys.length} key(s) from ${join(COLLECTIVE_DIR, ".env")}: ${envKeys.join(", ")}`);
// no model credential in the host env, or no boot: the Bank is the only auth source (a token and a key in the env let Claude Code bill the key while the town recorded the subscription: post-mortem 2026-10-30)
assertNoEnvCredentials();
const collectiveCfg = existsSync(COLLECTIVE_JSON) ? (JSON.parse(readFileSync(COLLECTIVE_JSON, "utf8")) as { port?: number; name?: string }) : {};
const PORT = Number(process.env.PORT ?? collectiveCfg.port ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = resolve(REPO_ROOT, townEnv("DATA") ?? join(COLLECTIVE_DIR, "data"));
// world.export() and the export route read it back through townEnv; set both names so either spelling sees it
process.env.MUSTER_TOWN_EXPORT = process.env.AGENT_TOWN_EXPORT = resolve(REPO_ROOT, townEnv("EXPORT") ?? join(COLLECTIVE_DIR, "export"));
// opt-in only: dev mode hands the admin token to any local browser that asks (`npm run dev` sets it)
/** the hosted collectives (docs/hosted-collectives.md): hub.db and one dir per collective, beside the Workshop's dir (/data/hosted on Fly) */
const HOSTED_DIR = resolve(DATA_DIR, "../..", "hosted");
const DEV = ["1", "true", "yes"].includes((townEnv("DEV") ?? "").trim().toLowerCase());

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const world = World.open(join(DATA_DIR, "town.db"));
  const seed = world.seedDefaults({
    adminName: townEnv("ADMIN_NAME"),
    townJsonPath: COLLECTIVE_JSON,
    collectivePath: COLLECTIVE_JSON,
    dataDir: DATA_DIR,
    manualPath: join(REPO_ROOT, "docs", "manual.md"),
  });
  console.log(seed.created ? `[server] seeded collective "${collectiveCfg.name ?? "?"}" in ${DATA_DIR}` : `[server] opened collective "${collectiveCfg.name ?? "?"}" from ${DATA_DIR}`);
  const desksOverride = desksFromEnv(townEnv("DESKS"));
  if (desksOverride) {
    world.town.setDesks({ ...world.town.desks(), ...desksOverride });
    console.log(`[server] desk settings from MUSTER_TOWN_DESKS: ${Object.keys(desksOverride).join(", ")}`);
  }
  world.start(10);

  const auth = loadAuthSettings({ dataDir: DATA_DIR, port: PORT });
  // off-site backup (deploy/README.md "Backups"): local copies beside the data dir (/data/workshop/backups on Fly); inert without the env
  const backup = new BackupJob({ db: world.db, dir: resolve(DATA_DIR, "..", "backups") });
  // in-process monitor (dc_f2hpf9u1ya): town events + Prod FYIs; outside alerts come from the VPS pinger reading /api/health (deploy/pinger)
  const counters = new Counters();
  const probes = processProbes(world, DATA_DIR, () => backup.snapshot(), counters);
  const monitor = new Monitor({ world, metrics: defaultMetrics(probes), counters });
  // the self-hosted towns directory (design dc_d6chojzl2a): muster.town only; behind Fly's proxy the client IP is Fly-Client-IP.
  // MUSTER_TOWN_DIRECTORY=on|off decides; unset, it is on where MUSTER_TOWN_PUBLIC_URL is muster.town (an [env] change in
  // fly.town.toml reaches the Machine only with an image deploy, the town's redeploy is code only)
  const directory = directoryEnabled(townEnv("DIRECTORY"), townEnv("PUBLIC_URL")) ? new Directory({ world, clientIpHeader: process.env.FLY_APP_NAME ? "fly-client-ip" : null }) : null;
  const runtimeMod = await loadRuntime();
  /** the server's own URL, once it listens: hosted runtimes call their MCP endpoint at <url>/<slug>/mcp */
  let url: string | null = null;
  /**
   * A hosted collective's runtime (step 5, docs/hosted-collectives.md): its own scrubbed env and claude dir, its own key only
   * (held "No key yet" without one), in-process sessions only, one at a time, its own export dir, no redeploy.
   */
  const startHosted = async (app: FastifyInstance, w: World, slug: string, dir: string): Promise<void> => {
    if (!runtimeMod || !url || app.runtime) return;
    try {
      app.runtime = await runtimeMod.startRuntime({ world: w, mcpUrl: `${url}/${slug}/mcp`, repoRoot: REPO_ROOT, collective: slug, exportDir: join(dir, "export"), hosted: { dir } });
    } catch (e) {
      console.warn(`[server] /${slug}/ runtime not started (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  // each hosted collective: its own World and app under /<slug>, its own runtime (started once the server listens), its own export
  // dir; the root's session cookie and secret (one sign-in for the whole host, step 2), its owner as its admin
  const hub: Hub = new Hub(HOSTED_DIR, async (w, row, dir) => {
    const app = await buildApp({
      world: w, dev: DEV, runtime: null, prefix: `/${row.slug}`, exportDir: join(dir, "export"),
      auth: { ...auth, admins: [], hosted: { slug: row.slug, ownerGithubId: row.ownerGithubId } },
      retire: (): unknown => hub.retire(row.slug),
    });
    // retire and shutdown close the app before its World: stop the runtime first
    app.addHook("onClose", async () => { await (app.runtime?.close?.() ?? app.runtime?.stop?.()); });
    await startHosted(app, w, row.slug, dir);
    return app;
  });
  await hub.openAll();
  console.log(`[server] hub ${HOSTED_DIR}: ${hub.count} hosted collective(s)${hub.count ? ": " + hub.list("active").map((r) => "/" + r.slug + "/").join(", ") : ""}`);
  const app = await buildApp({ world, dev: DEV, auth, collective: basename(COLLECTIVE_DIR), backup, monitor, hub, directory });
  await app.listen({ port: PORT, host: HOST });
  url = `http://localhost:${PORT}`;
  console.log(`[server] Muster Town at ${url} (dev=${DEV})`);
  // the token itself never goes to stdout (it would land in journald): seedDefaults wrote it to <data>/admin-token (0600)
  console.log(`[server] admin (${seed.admin.name}) token: in ${join(DATA_DIR, "admin-token")}`);
  console.log(world.secrets.keyConfigured() ? "[server] MUSTER_TOWN_DATA_KEY set: collective secrets can be stored" : "[server] no MUSTER_TOWN_DATA_KEY: collective secrets can't be stored (they are never kept in plaintext)");
  console.log(auth.githubClientId ? `[server] GitHub login on (callback ${auth.publicUrl}/auth/github/callback; ${auth.admins.length} admin login(s))` : "[server] GitHub login off (no GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET); guests are read-only");
  console.log(`[server] MCP endpoint: ${url}/mcp (agent tokens only)`);
  backup.start();
  monitor.start();
  directory?.start();

  try {
    if (!runtimeMod) throw new Error(runtimeError);
    // the manager reads the live code (Read, Grep, Glob) from a snapshot under .tmp/ (gitignored)
    app.runtime = await runtimeMod.startRuntime({ world, mcpUrl: `${url}/mcp`, repoRoot: REPO_ROOT, collective: basename(COLLECTIVE_DIR), codeDir: join(REPO_ROOT, ".tmp", "code-main") });
    console.log("[server] runtime started");
  } catch (e) {
    console.warn(`[server] runtime not started (${e instanceof Error ? e.message : String(e)}); interrupts queue for the desk`);
  }
  // the hosted collectives opened at boot mounted before the URL was known
  for (const r of hub.list("active")) {
    const hApp = hub.match(`/${r.slug}/`), hWorld = hub.world(r.slug);
    if (hApp && hWorld) await startHosted(hApp, hWorld, r.slug, hub.dirOf(r.slug));
  }

  const shutdown = async (sig: string) => {
    console.log(`[server] ${sig}, shutting down`);
    try { await app.close(); } finally { world.close(); process.exit(0); }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

type RuntimeModule = { startRuntime: (o: { world: World; mcpUrl: string; repoRoot: string; collective: string; exportDir?: string; codeDir?: string; hosted?: { dir: string } }) => RuntimeHooks | Promise<RuntimeHooks> };
let runtimeError = "";
async function loadRuntime(): Promise<RuntimeModule | null> {
  try {
    const runtimePkg = "@muster-town/runtime"; // variable specifier: the server typechecks and runs without it
    const mod = (await import(runtimePkg)) as Partial<RuntimeModule>;
    if (typeof mod.startRuntime !== "function") throw new Error("@muster-town/runtime does not export startRuntime");
    return mod as RuntimeModule;
  } catch (e) {
    runtimeError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

main().catch((e) => {
  console.error("[server] failed to start", e);
  process.exit(1);
});
