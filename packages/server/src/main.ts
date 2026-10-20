/**
 * Process entry: open the world, seed if empty, start the tick, the HTTP/WS/MCP server, and the runtime.
 * Env: AGENT_TOWN_COLLECTIVE (collectives/climate), PORT (collective.json port or 4321), AGENT_TOWN_DATA (<collective>/data),
 * AGENT_TOWN_EXPORT (<collective>/export), AGENT_TOWN_DEV, AGENT_TOWN_ADMIN_NAME.
 */
import { World } from "@muster-town/core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { loadAuthSettings } from "./auth/index.ts";
import { loadEnvFile } from "./env.ts";
import type { RuntimeHooks } from "./context.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** A collective = one instance of the town: <dir>/collective.json + <dir>/data + <dir>/export. */
const COLLECTIVE_DIR = resolve(REPO_ROOT, process.env.AGENT_TOWN_COLLECTIVE ?? "collectives/climate");
const COLLECTIVE_JSON = join(COLLECTIVE_DIR, "collective.json");

const envKeys = loadEnvFile(join(COLLECTIVE_DIR, ".env"));
if (envKeys.length) console.log(`[server] loaded ${envKeys.length} key(s) from ${join(COLLECTIVE_DIR, ".env")}: ${envKeys.join(", ")}`);
const collectiveCfg = existsSync(COLLECTIVE_JSON) ? (JSON.parse(readFileSync(COLLECTIVE_JSON, "utf8")) as { port?: number; name?: string }) : {};
const PORT = Number(process.env.PORT ?? collectiveCfg.port ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = resolve(REPO_ROOT, process.env.AGENT_TOWN_DATA ?? join(COLLECTIVE_DIR, "data"));
process.env.AGENT_TOWN_EXPORT = resolve(REPO_ROOT, process.env.AGENT_TOWN_EXPORT ?? join(COLLECTIVE_DIR, "export"));
const DEV = process.env.AGENT_TOWN_DEV !== undefined
  ? !["0", "false", "no", ""].includes(process.env.AGENT_TOWN_DEV.toLowerCase())
  : process.env.NODE_ENV !== "production";

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const world = World.open(join(DATA_DIR, "town.db"));
  const seed = world.seedDefaults({
    adminName: process.env.AGENT_TOWN_ADMIN_NAME,
    townJsonPath: COLLECTIVE_JSON,
    collectivePath: COLLECTIVE_JSON,
    dataDir: DATA_DIR,
  });
  console.log(seed.created ? `[server] seeded collective "${collectiveCfg.name ?? "?"}" in ${DATA_DIR}` : `[server] opened collective "${collectiveCfg.name ?? "?"}" from ${DATA_DIR}`);
  world.start(10);

  const auth = loadAuthSettings({ dataDir: DATA_DIR, port: PORT });
  const app = await buildApp({ world, dev: DEV, auth });
  await app.listen({ port: PORT, host: HOST });
  const url = `http://localhost:${PORT}`;
  console.log(`[server] Agent Town at ${url} (dev=${DEV})`);
  console.log(`[server] admin (${seed.admin.name}) token: ${seed.adminToken}`);
  console.log(auth.githubClientId ? `[server] GitHub login on (callback ${auth.publicUrl}/auth/github/callback; ${auth.admins.length} admin login(s))` : "[server] GitHub login off (no GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET); guests are read-only");
  console.log(`[server] MCP endpoint: ${url}/mcp (agent tokens only)`);

  try {
    const runtimePkg = "@muster-town/runtime"; // variable specifier: the server typechecks and runs without it
    const mod = (await import(runtimePkg)) as { startRuntime?: (o: { world: World; mcpUrl: string; repoRoot: string; collective: string }) => RuntimeHooks | Promise<RuntimeHooks> };
    if (typeof mod.startRuntime !== "function") throw new Error("@muster-town/runtime does not export startRuntime");
    app.runtime = await mod.startRuntime({ world, mcpUrl: `${url}/mcp`, repoRoot: REPO_ROOT, collective: basename(COLLECTIVE_DIR) });
    console.log("[server] runtime started");
  } catch (e) {
    console.warn(`[server] runtime not started (${e instanceof Error ? e.message : String(e)}); chat/interrupt return 503`);
  }

  const shutdown = async (sig: string) => {
    console.log(`[server] ${sig}, shutting down`);
    try { await app.close(); } finally { world.close(); process.exit(0); }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[server] failed to start", e);
  process.exit(1);
});
