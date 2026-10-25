/** killTreeCommand against real processes: the desk CLI and the Claude Code child it spawned both stop. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { killPattern, killTreeCommand } from "../src/desk/backend.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasPgrep = spawnSync("sh", ["-c", "command -v pgrep"]).status === 0;

describe.skipIf(process.platform !== "linux" || !hasPgrep)("killTreeCommand", () => {
  test("stops the session's process and its children, which a TERM on the parent alone leaves running", async () => {
    const sid = `se_${randomBytes(6).toString("hex")}`;
    // stands in for `node cli.ts run --session <id>`: spawns a child (Claude Code) that ignores its parent's death
    const parent = spawn(process.execPath, ["-e", `
      const c = require("node:child_process").spawn("sleep", ["300"], { stdio: "ignore" });
      process.stdout.write(String(c.pid) + "\\n");
      process.on("SIGTERM", () => process.exit(143));
      setInterval(() => {}, 1000);
    `, "run", "--session", sid], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((r) => parent.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    try {
      expect(alive(parent.pid!) && alive(childPid)).toBe(true);
      const r = spawnSync("sh", ["-c", killTreeCommand(killPattern(["agent-town-desk", "run", "--session", sid]), 1)], { timeout: 10_000 });
      expect(r.status).toBe(0);
      await new Promise((res) => setTimeout(res, 100));
      expect(alive(childPid)).toBe(false);
      expect(parent.exitCode !== null || parent.signalCode !== null || !alive(parent.pid!)).toBe(true);
    } finally {
      for (const p of [parent.pid!, childPid]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  test("no match: exits 0 and signals nothing", () => {
    const r = spawnSync("sh", ["-c", killTreeCommand("[r]un --session se_nobody_here")], { timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});
