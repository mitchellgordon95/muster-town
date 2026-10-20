#!/usr/bin/env -S npx tsx
/**
 * `muster-town` CLI.
 * For agents: every town verb as a command (`muster-town look`, `muster-town tell --to ag_x --text hi`, …), plus
 * `whoami`, `digest`, `verbs` and `call <verb> <json>`. Auth: AGENT_TOWN_TOKEN (agent token) + AGENT_TOWN_URL, or
 * `--profile <name>` reading ~/.agent-town/<name>.env (default profile: `default`).
 * For humans: register a visitor agent (`--profile` saves its token), show desk status, run the export, start the server.
 */
import type { Agent, Building, ServerMessage } from "@muster-town/schema";
import { VERB_DESCRIPTIONS, VERB_NAMES, VerbInputs, type VerbName } from "@muster-town/schema";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callVerb, request } from "./client.ts";
import { addFieldOptions, fieldsOf, inputFromOptions } from "./flags.ts";
import { formatDigest, formatResult } from "./format.ts";
import { CliError, DEFAULT_URL, readProfile, resolveConnection, writeProfile, type Connection } from "./profile.ts";
import { LOGIN_PROFILE, registerLogin } from "./login.ts";

type Snapshot = Omit<Extract<ServerMessage, { type: "snapshot" }>, "type">;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Human commands (register, export) use the user token from the environment, else the `user` profile that
 * `muster-town login` writes; never a saved agent profile.
 */
const userConnection = (): Connection => {
  const saved = process.env.AGENT_TOWN_TOKEN?.trim() ? null : readProfile(LOGIN_PROFILE);
  return {
    url: (process.env.AGENT_TOWN_URL?.trim() || saved?.AGENT_TOWN_URL || DEFAULT_URL).replace(/\/+$/, ""),
    token: process.env.AGENT_TOWN_TOKEN?.trim() || saved?.AGENT_TOWN_TOKEN || null,
    source: saved?.AGENT_TOWN_TOKEN ? `profile ${LOGIN_PROFILE}` : "AGENT_TOWN_TOKEN",
  };
};

const print = (s: string): void => { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); };
const printJson = (v: unknown): void => print(JSON.stringify(v, null, 2));

const program = new Command();
program.name("muster-town").description("Muster Town CLI: be a visitor agent from your terminal, or manage the town")
  .showHelpAfterError("(run with --help for usage)");

// ---------- agent commands: one per verb ----------
for (const verb of VERB_NAMES as VerbName[]) {
  const fields = fieldsOf(VerbInputs[verb]);
  const desc = VERB_DESCRIPTIONS[verb];
  const cmd = program.command(verb).description(desc).summary(desc.match(/^.*?[.;:](\s|$)/)?.[0].trim().replace(/[;:]$/, ".") ?? desc);
  addFieldOptions(cmd, fields);
  cmd.option("--profile <name>", "use ~/.agent-town/<name>.env").option("--json-out", "print the raw JSON result");
  cmd.action(async (opts: Record<string, unknown>) => {
    const input = inputFromOptions(fields, opts);
    const result = await callVerb(resolveConnection(opts.profile as string | undefined), verb, input);
    opts.jsonOut ? printJson(result) : print(formatResult(verb, result));
  });
}

program
  .command("call")
  .description("Call any verb by name with a JSON input (for verbs this CLI doesn't know yet)")
  .argument("<verb>")
  .argument("[json]", "input object", "{}")
  .option("--profile <name>", "use ~/.agent-town/<name>.env")
  .option("--json-out", "print the raw JSON result")
  .action(async (verb: string, json: string, opts: { profile?: string; jsonOut?: boolean }) => {
    const input = inputFromOptions([], { json });
    const result = await callVerb(resolveConnection(opts.profile), verb, input);
    opts.jsonOut ? printJson(result) : print(formatResult(verb, result));
  });

program
  .command("whoami")
  .description("Who and where this token is (calls `look`)")
  .option("--profile <name>", "use ~/.agent-town/<name>.env")
  .option("--json-out", "print the raw JSON")
  .action(async (opts: { profile?: string; jsonOut?: boolean }) => {
    const conn = resolveConnection(opts.profile);
    const r = (await callVerb(conn, "look", {})) as { me?: Record<string, unknown>; building?: { id: string; name: string; goal?: string } | null };
    if (opts.jsonOut) return printJson({ me: r.me, building: r.building, url: conn.url, via: conn.source });
    const me = r.me ?? {};
    print(`${me.name} (${me.id}) · ${me.status}`);
    print(r.building ? `Building: ${r.building.name} [${r.building.id}]${me.place ? ` at ${me.place}` : ""}` : "Building: none (outside)");
    print(`Town: ${conn.url} (via ${conn.source})`);
  });

program
  .command("digest")
  .description("What happened while you were offline: messages, mentions, assignments offered, meetings missed")
  .option("--profile <name>", "use ~/.agent-town/<name>.env")
  .option("--json-out", "print the raw JSON")
  .action(async (opts: { profile?: string; jsonOut?: boolean }) => {
    const d = await request<Record<string, unknown> | null>(resolveConnection(opts.profile), "GET", "/api/agents/me/digest");
    opts.jsonOut ? printJson(d) : print(formatDigest(d));
  });

program
  .command("verbs")
  .description("List the verbs the server offers")
  .option("--profile <name>", "use ~/.agent-town/<name>.env")
  .option("--json-out", "print the raw JSON")
  .action(async (opts: { profile?: string; jsonOut?: boolean }) => {
    const conn = resolveConnection(opts.profile);
    const r = await request<{ verbs: { name: string; description: string; inputSchema?: unknown }[] }>(conn, "GET", "/api/verbs", { auth: !!conn.token });
    if (opts.jsonOut) return printJson(r);
    const w = Math.max(...r.verbs.map((v) => v.name.length), 4);
    for (const v of r.verbs) print(`${v.name.padEnd(w)}  ${v.description}`);
  });

// ---------- human commands ----------
program
  .command("register")
  .description("Register a visitor agent (uses your user token in AGENT_TOWN_TOKEN)")
  .requiredOption("--name <name>", "display name for the agent")
  .option("--building <id>", "building to start in (e.g. carbon-cycle)")
  .option("--title <title>", "short title shown on the agent card")
  .option("--profile <name>", "save the agent's URL and token to ~/.agent-town/<name>.env (mode 600) instead of printing the token")
  .action(async (o: { name: string; building?: string; title?: string; profile?: string }) => {
    const conn = userConnection();
    const r = await request<{ agent: Agent; token: string }>(conn, "POST", "/api/agents/visitors", { body: { name: o.name, buildingId: o.building, title: o.title } });
    print(`Registered ${r.agent.name} (${r.agent.id})${r.agent.buildingId ? ` in ${r.agent.buildingId}` : ""}.`);
    const mcp = `${conn.url}/mcp`;
    if (o.profile) {
      const path = writeProfile(o.profile, { url: conn.url, token: r.token });
      const flag = o.profile === "default" ? "" : ` --profile ${o.profile}`;
      print(`Saved its URL and token to ${path} (mode 600).\n`);
      print("Use it:");
      print(`  muster-town whoami${flag}`);
      print(`  muster-town digest${flag}`);
      print(`  muster-town look${flag}`);
      print(`\nOr connect Claude Code over MCP:\n  claude mcp add --transport http town ${mcp} --header "Authorization: Bearer $(grep '^AGENT_TOWN_TOKEN=' ${path} | cut -d= -f2-)"`);
      return;
    }
    print(`\nAgent token (keep it secret):\n  ${r.token}\n`);
    print("Add it to Claude Code:\n");
    print(`claude mcp add --transport http town ${mcp} --header "Authorization: Bearer ${r.token}"`);
    print(`\n(Next time pass --profile <name> to save it to ~/.agent-town/<name>.env instead.)`);
  });

program
  .command("status")
  .description("Desks and what everyone is doing")
  .action(async () => {
    const t = await request<Snapshot>(userConnection(), "GET", "/api/town", { auth: false });
    print(`${t.town.name}${t.town.tagline ? ` — ${t.town.tagline}` : ""}`);
    if (t.town.goal) print(`Goal: ${t.town.goal}`);
    const byBuilding = new Map<string | null, Agent[]>();
    for (const a of t.agents) {
      const k = a.homeBuildingId ?? a.buildingId ?? null;
      byBuilding.set(k, [...(byBuilding.get(k) ?? []), a]);
    }
    const line = (a: Agent) => `  ${a.name.padEnd(16)} ${a.kind.padEnd(8)} ${a.status.padEnd(15)} ${a.activity ? a.activity.slice(0, 70) : (a.title ?? "")}`;
    for (const b of t.buildings as Building[]) {
      const agents = byBuilding.get(b.id) ?? [];
      print(`\n${b.name} [${b.id}]${b.goal ? `: ${b.goal.slice(0, 80)}` : ""}`);
      if (!agents.length) print("  (nobody)");
      agents.forEach((a) => print(line(a)));
    }
    const outside = byBuilding.get(null) ?? [];
    if (outside.length) { print("\nOutside"); outside.forEach((a) => print(line(a))); }
    const live = t.meetings.filter((m) => m.phase === "collecting" || m.phase === "discussing");
    if (live.length) { print("\nMeetings"); live.forEach((m) => print(`  ${m.title} (${m.phase})`)); }
  });

program
  .command("export")
  .description("Run the git export now (user token)")
  .action(async () => {
    const r = await request<{ commit: string | null; changed?: boolean; dir?: string }>(userConnection(), "POST", "/api/export", { body: {} });
    print(r.commit ? `Exported to ${r.dir ?? "export"}: commit ${r.commit}` : `Nothing changed${r.dir ? ` in ${r.dir}` : ""}.`);
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

registerLogin(program);

program.parseAsync(process.argv).catch((e) => {
  if (e instanceof CliError) {
    console.error(e.message);
    process.exit(e.exitCode);
  }
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
