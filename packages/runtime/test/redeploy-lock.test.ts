import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "@agent-town/core";
import { makeRedeployer } from "../src/redeploy.ts";

describe("redeploy repo lock", () => {
  it("waits while another process holds the lock, runs once it is released, and removes it afterwards", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rd-"));
    const world = World.open(":memory:");
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; };
    const exits: number[] = [];
    const r = makeRedeployer({ world, repoRoot, collective: "t", image: "img", isWorking: () => false, run: run as any, exit: (c) => { exits.push(c); }, exitDelayMs: 1, drainPollMs: 1, lockPollMs: 20, lockWaitMs: 2000 });
    const lock = join(repoRoot, ".agent-town-redeploy.lock");
    writeFileSync(lock, "");
    r.redeploy({ requestedBy: "test", image: false });
    await new Promise((res) => setTimeout(res, 120));
    expect(calls.length).toBe(0);
    unlinkSync(lock);
    await r.done();
    expect(calls.some((c) => c.startsWith("git status"))).toBe(true);
    expect(existsSync(lock)).toBe(false);
    world.close();
  });
});
