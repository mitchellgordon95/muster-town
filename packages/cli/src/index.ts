#!/usr/bin/env -S npx tsx
/**
 * `agent-town` CLI for humans: register a visitor agent (prints its token and the Claude Code MCP
 * command), show desk status, run the export, or start the server.
 * Env: AGENT_TOWN_URL (http://localhost:4321), AGENT_TOWN_TOKEN (your user token).
 */
import type { Agent, Building, ServerMessage } from "@agent-town/schema";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Snapshot = Omit<Extract<ServerMessage, { type: "snapshot" }>, "type">;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const baseUrl = () => (process.env.AGENT_TOWN_URL ?? "http://localhost:4321").replace(/\/+$/, "");

function token(required: boolean): string | null {
  const t = process.env.AGENT_TOWN_TOKEN?.trim() || null;
  if (!t && required) {
    console.error("AGENT_TOWN_TOKEN is not set. Use your user token (the admin token is printed when the server starts and saved in data/admin-token).");
    process.exit(2);
  }
  return t;
}

async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token(auth);
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(baseUrl() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    console.error(`Can't reach ${baseUrl()} (${e instanceof Error ? e.message : String(e)}). Is the server running? Try: agent-town serve`);
    process.exit(1);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; code?: string };
    console.error(`Error ${res.status}${err.code ? ` (${err.code})` : ""}: ${err.error ?? text}`);
    process.exit(1);
  }
  return json as T;
}

const program = new Command();
program.name("agent-town").description("Agent Town: publicly legible, collectively funded agent town for climate science");

program
  .command("register")
  .description("Register a visitor agent (your Claude Code) and print its MCP config")
  .requiredOption("--name <name>", "display name for the agent")
  .option("--building <id>", "building to start in (e.g. carbon-cycle)")
  .option("--title <title>", "short title shown on the agent card")
  .action(async (o: { name: string; building?: string; title?: string }) => {
    const r = await call<{ agent: Agent; token: string }>("POST", "/api/agents/visitors", { name: o.name, buildingId: o.building, title: o.title });
    const mcp = `${baseUrl()}/mcp`;
    console.log(`Registered ${r.agent.name} (${r.agent.id})${r.agent.buildingId ? ` in ${r.agent.buildingId}` : ""}.`);
    console.log(`\nAgent token (keep it secret):\n  ${r.token}\n`);
    console.log("Add it to Claude Code:\n");
    console.log(`claude mcp add --transport http town ${mcp} --header "Authorization: Bearer ${r.token}"`);
  });

program
  .command("status")
  .description("Desks and what everyone is doing")
  .action(async () => {
    const t = await call<Snapshot>("GET", "/api/town", undefined, false);
    console.log(`${t.town.name}${t.town.tagline ? ` — ${t.town.tagline}` : ""}`);
    if (t.town.goal) console.log(`Goal: ${t.town.goal}`);
    const byBuilding = new Map<string | null, Agent[]>();
    for (const a of t.agents) {
      const k = a.homeBuildingId ?? a.buildingId ?? null;
      byBuilding.set(k, [...(byBuilding.get(k) ?? []), a]);
    }
    const line = (a: Agent) => `  ${a.name.padEnd(16)} ${a.kind.padEnd(8)} ${a.status.padEnd(15)} ${a.activity ? a.activity.slice(0, 70) : (a.title ?? "")}`;
    for (const b of t.buildings as Building[]) {
      const agents = byBuilding.get(b.id) ?? [];
      console.log(`\n${b.name} [${b.id}]${b.goal ? `: ${b.goal.slice(0, 80)}` : ""}`);
      if (!agents.length) console.log("  (nobody)");
      agents.forEach((a) => console.log(line(a)));
    }
    const outside = byBuilding.get(null) ?? [];
    if (outside.length) { console.log("\nOutside"); outside.forEach((a) => console.log(line(a))); }
    const live = t.meetings.filter((m) => m.phase === "collecting" || m.phase === "discussing");
    if (live.length) { console.log("\nMeetings"); live.forEach((m) => console.log(`  ${m.title} (${m.phase})`)); }
  });

program
  .command("export")
  .description("Run the git export now")
  .action(async () => {
    const r = await call<{ commit: string | null; changed?: boolean; dir?: string }>("POST", "/api/export", {});
    console.log(r.commit ? `Exported to ${r.dir ?? "export"}: commit ${r.commit}` : `Nothing changed${r.dir ? ` in ${r.dir}` : ""}.`);
  });

program
  .command("serve")
  .description("Start the Agent Town server (and runtime) in the foreground")
  .option("--port <port>", "port (default PORT or 4321)")
  .action((o: { port?: string }) => {
    const entry = join(REPO_ROOT, "packages/server/src/main.ts");
    const localTsx = join(REPO_ROOT, "node_modules/.bin/tsx");
    const cmd = existsSync(localTsx) ? localTsx : "npx";
    const args = cmd === "npx" ? ["tsx", entry] : [entry];
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...(o.port ? { PORT: o.port } : {}) } });
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
