#!/usr/bin/env node
/**
 * agent-town-desk — the resident host that runs inside a desk container.
 *   agent-town-desk run --session <id>   (env: AGENT_TOWN_URL, AGENT_TOWN_TOKEN, ANTHROPIC_API_KEY, GH_TOKEN?, DESK_MODEL?, DESK_MAX_TURNS?)
 *   agent-town-desk doctor
 */
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { runSession, EXIT_ERROR } from "./run.ts";
import { realSdk } from "./sdk.ts";
import { TownClient } from "./town.ts";

const log = (line: string) => process.stderr.write(`[desk] ${line}\n`);

function version(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0]!;
  } catch {
    return "missing";
  }
}

const program = new Command();
program.name("agent-town-desk").description("Agent Town resident host: runs one work session inside a desk");

program
  .command("run")
  .description("run one work session against the town")
  .requiredOption("--session <id>", "session id created by the town runtime")
  .action(async (opts: { session: string }) => {
    const url = process.env.AGENT_TOWN_URL;
    const token = process.env.AGENT_TOWN_TOKEN;
    if (!url || !token) {
      log("AGENT_TOWN_URL and AGENT_TOWN_TOKEN must be set");
      process.exit(EXIT_ERROR);
    }
    if (!process.env.ANTHROPIC_API_KEY) log("warning: ANTHROPIC_API_KEY is not set");
    const town = new TownClient({ baseUrl: url, token });
    const code = await runSession(opts.session, { town, sdk: realSdk, log });
    log(`exit ${code}`);
    process.exit(code);
  });

program
  .command("doctor")
  .description("print tool versions and whether the town answers")
  .action(async () => {
    const lines: [string, string][] = [
      ["node", process.version],
      ["git", version("git", ["--version"])],
      ["gh", version("gh", ["--version"])],
      ["python", version("python3", ["--version"])],
      ["numpy", version("python3", ["-c", "import numpy; print(numpy.__version__)"])],
      ["claude", version("claude", ["--version"])],
    ];
    const url = process.env.AGENT_TOWN_URL;
    let town = "AGENT_TOWN_URL not set";
    if (url) {
      try {
        const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) });
        town = `${url} /api/health → ${res.status}`;
      } catch (e) {
        town = `${url} unreachable (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    lines.push(["town", town]);
    for (const [k, v] of lines) process.stdout.write(`${k.padEnd(7)} ${v}\n`);
  });

program.parseAsync(process.argv).catch((e) => {
  log(e instanceof Error ? e.message : String(e));
  process.exit(EXIT_ERROR);
});
