/** v1.2 merge rule: merge=green readies + squash-merges the branch's open PR when every check passes. Fake `gh` on PATH. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { greenMerge } from "../src/merge.ts";
import { EXIT_OK, runSession } from "../src/run.ts";
import { TownClient } from "../src/town.ts";
import { assistant, brief, fakeSdk, startFakeTown, toolResult, TOKEN, type FakeTown } from "./helpers.ts";

let root: string;
let ghLog: string;
const savedPath = process.env.PATH;

/** A fake `gh`: logs its argv; `pr view` answers with $FAKE_PR (or exits 1 when unset); everything else succeeds. */
function installFakeGh(pr: { number: number; isDraft: boolean; state: string } | null) {
  const bin = join(root, "bin");
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  const script = `#!/bin/sh
echo "$*" >> "${ghLog}"
if [ "$1 $2" = "pr view" ]; then
  ${pr ? `echo '${JSON.stringify(pr)}'` : `echo "no pull requests found for branch" >&2; exit 1`}
fi
exit 0
`;
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}
const ghCalls = () => { try { return readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const ws = (checks: string[], merge: "green" | "human" = "green") => ({ repoUrl: "https://example.com/r.git", base: "main", branch: "agent/ada/co2", branchPrefix: "agent", dir: root, merge, checks });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desk-merge-"));
  ghLog = join(root, "gh.log");
});
afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("greenMerge", () => {
  it("checks pass: readies the draft PR and squash-merges it with --delete-branch", async () => {
    installFakeGh({ number: 7, isDraft: true, state: "OPEN" });
    const r = await greenMerge(ws(["echo typecheck > check1.txt", "test -f check1.txt"]));
    expect(r).toEqual({ merged: true, prNumber: 7, line: "Merged PR #7 (checks green)" });
    expect(ghCalls()).toEqual([
      "pr view agent/ada/co2 --json number,isDraft,state",
      "pr ready 7",
      "pr merge 7 --squash --delete-branch",
    ]);
    expect(readFileSync(join(root, "check1.txt"), "utf8").trim()).toBe("typecheck"); // checks ran in the checkout
  });

  it("a non-draft PR skips `gh pr ready`", async () => {
    installFakeGh({ number: 8, isDraft: false, state: "OPEN" });
    expect((await greenMerge(ws(["true"])))?.merged).toBe(true);
    expect(ghCalls()).toEqual(["pr view agent/ada/co2 --json number,isDraft,state", "pr merge 8 --squash --delete-branch"]);
  });

  it("a failing check leaves the PR open: no ready, no merge, later checks skipped", async () => {
    installFakeGh({ number: 9, isDraft: true, state: "OPEN" });
    const r = await greenMerge(ws(["true", "exit 3", "touch never.txt"]));
    expect(r).toMatchObject({ merged: false, prNumber: 9, line: "Checks failed, PR left open", detail: "exit 3 exited 3" });
    expect(ghCalls()).toEqual(["pr view agent/ada/co2 --json number,isDraft,state"]);
  });

  it("no PR, a closed PR, or merge=human: nothing attempted", async () => {
    installFakeGh(null);
    expect(await greenMerge(ws(["true"]))).toBeNull();
    installFakeGh({ number: 3, isDraft: false, state: "MERGED" });
    expect(await greenMerge(ws(["true"]))).toBeNull();
    writeFileSync(ghLog, "");
    expect(await greenMerge(ws(["true"], "human"))).toBeNull();
    expect(ghCalls()).toEqual([]);
  });
});

describe("runSession with merge=green", () => {
  let town: FakeTown;
  beforeEach(async () => { town = await startFakeTown(); });
  afterEach(async () => { await town.close(); });
  const reporting = () => fakeSdk(async function* () {
    yield assistant({ type: "tool_use", id: "r1", name: "mcp__town__submit_report", input: { title: "PR", body: "b", verdict: "continue" } });
    yield toolResult("r1");
  });
  const deps = (sdk: ReturnType<typeof fakeSdk>) => ({
    town: new TownClient({ baseUrl: town.url, token: TOKEN, backoffMs: [5, 5] }), sdk,
    env: { AGENT_TOWN_TOKEN: TOKEN } as NodeJS.ProcessEnv, log: () => undefined, controlIntervalMs: 20, flushMs: 10,
    setupWorkspace: () => root,
  });

  it("checks pass → activity line and session-end with merged + prNumber", async () => {
    installFakeGh({ number: 12, isDraft: true, state: "OPEN" });
    town.briefs.set("s1", brief("s1", { workspace: ws(["true"]) }));
    expect(await runSession("s1", deps(reporting()))).toBe(EXIT_OK);
    expect(town.activity).toContainEqual({ session: "s1", kind: "status", text: "Merged PR #12 (checks green)" });
    expect(town.ends[0]).toMatchObject({ reportSubmitted: true, merged: true, prNumber: 12 });
  });

  it("checks fail → 'Checks failed, PR left open' and merged: false", async () => {
    installFakeGh({ number: 13, isDraft: true, state: "OPEN" });
    town.briefs.set("s1", brief("s1", { workspace: ws(["false"]) }));
    await runSession("s1", deps(reporting()));
    expect(town.activity).toContainEqual({ session: "s1", kind: "status", text: "Checks failed, PR left open" });
    expect(town.ends[0]).toMatchObject({ merged: false, prNumber: 13 });
    expect(ghCalls().some((c) => c.startsWith("pr merge"))).toBe(false);
  });

  it("no report → no merge attempt", async () => {
    installFakeGh({ number: 14, isDraft: true, state: "OPEN" });
    town.briefs.set("s1", brief("s1", { workspace: ws(["true"]) }));
    await runSession("s1", deps(fakeSdk(async function* () { yield assistant({ type: "text", text: "no report" }); })));
    expect(ghCalls()).toEqual([]);
    expect(town.ends[0]!.merged).toBeUndefined();
  });
});
