/**
 * Process entry: open the world, seed if empty, start the tick, the HTTP/WS/MCP server, and the runtime.
 * Env: PORT (4321), AGENT_TOWN_DATA (./data), AGENT_TOWN_EXPORT (./export), AGENT_TOWN_DEV, AGENT_TOWN_ADMIN_NAME.
 */
import { World } from "@agent-town/core";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import type { RuntimeHooks } from "./context.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = resolve(process.env.AGENT_TOWN_DATA ?? "./data");
process.env.AGENT_TOWN_EXPORT = resolve(process.env.AGENT_TOWN_EXPORT ?? "./export");
const DEV = process.env.AGENT_TOWN_DEV !== undefined
  ? !["0", "false", "no", ""].includes(process.env.AGENT_TOWN_DEV.toLowerCase())
  : process.env.NODE_ENV !== "production";

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const world = World.open(join(DATA_DIR, "town.db"));
  const seed = world.seedDefaults({
    adminName: process.env.AGENT_TOWN_ADMIN_NAME,
    townJsonPath: join(REPO_ROOT, "town.json"),
    importDir: join(REPO_ROOT, "buildings/carbon-cycle"),
    dataDir: DATA_DIR,
  });
  console.log(seed.created ? `[server] seeded a new town in ${DATA_DIR}` : `[server] opened town in ${DATA_DIR}`);
  world.start(10);

  const app = await buildApp({ world, dev: DEV });
  await app.listen({ port: PORT, host: HOST });
  const url = `http://localhost:${PORT}`;
  console.log(`[server] Agent Town at ${url} (dev=${DEV})`);
  console.log(`[server] admin (${seed.admin.name}) token: ${seed.adminToken}`);
  console.log(`[server] MCP endpoint: ${url}/mcp (agent tokens only)`);

  try {
    const runtimePkg = "@agent-town/runtime"; // variable specifier: the server typechecks and runs without it
    const mod = (await import(runtimePkg)) as { startRuntime?: (o: { world: World; mcpUrl: string }) => RuntimeHooks | Promise<RuntimeHooks> };
    if (typeof mod.startRuntime !== "function") throw new Error("@agent-town/runtime does not export startRuntime");
    app.runtime = await mod.startRuntime({ world, mcpUrl: `${url}/mcp` });
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
