import { describe, expect, it } from "vitest";
import { describeCommand, describeTool } from "../src/describe.ts";

const bash = (command: string, description?: string) => describeTool(null as never, "Bash", { command, description });

describe("Bash bubbles read as plain words, never the raw command", () => {
  it("keeps the agent's own description", () => {
    expect(bash("npm test", "Run the runtime tests")).toBe("Running: Run the runtime tests");
  });

  it("describes the live samples from dc_ycvjogelnw without echoing them", () => {
    expect(bash("cd /tmp; python3 - <<'EOF'\nimport json\nprint(1)\nEOF")).toBe("Running a Python script");
    expect(bash(`curl -s -X POST "$AGENT_TOWN_URL/api/desk/call" -H "Authorization: Bearer $AGENT_TOWN_TOKEN" -d '{}'`)).toBe("Calling the town API");
    expect(bash("curl -s https://api.github.com/repos/x/y")).toBe("Calling a web API");
  });

  it("maps common programs past cd/env prefixes", () => {
    const cases: [string, string][] = [
      ["cd /home/agent/work/agent-town && git status --short", "Working with git (status)"],
      ["git -C /home/agent/work/agent-town log --oneline -5", "Working with git (log)"],
      ["gh pr create --draft --fill", "Working with GitHub (pr)"],
      ["cd packages/runtime && npx vitest run test/describe.test.ts", "Running tests"],
      ["npm run typecheck 2>&1 | tail -20", "Type-checking the code"],
      ["npm test", "Running tests"],
      ["pnpm install", "Installing packages"],
      ["FOO=1 BAR=2 node scripts/x.mjs", "Running a Node script"],
      ["grep -rn describeTool packages/*/src | head", "Searching files"],
      ["rg -n foo", "Searching files"],
      ["ls packages/runtime/test", "Listing files"],
      ["sed -i 's/a/b/' x.ts", "Editing files"],
      ["sed -n 1,40p x.ts", "Reading files"],
      ["cat > /tmp/x.json <<'EOF'\n{}\nEOF", "Writing a file"],
      ["echo start; sleep 5; python3.11 -m pytest -q", "Running tests"],
      ["echo hello", "Printing a note"],
      ["timeout 60 /usr/bin/python3 run.py", "Running a Python script"],
      ["bash -c 'npm run build'", "Building the code"],
      ["cd /tmp", "Running a shell command"],
      ["./some-tool --flag /secret/path", "Running a shell command"],
      ["", "Running a shell command"],
    ];
    for (const [cmd, want] of cases) expect(describeCommand(cmd), cmd).toBe(want);
  });

  it("never leaks a path, env var or flag from an undescribed command", () => {
    for (const cmd of ["cd /tmp; python3 - <<'EOF'", `curl -s -X POST "$AGENT_TOWN_URL/api/x"`, "git -C /home/agent/x push origin HEAD", "weird-binary --token=abc /etc/passwd"]) {
      expect(bash(cmd)).not.toMatch(/[/$=]|--|tmp|TOKEN|EOF/);
    }
  });
});

describe("town tool bubbles read as plain words", () => {
  const world = { nameOf: (id: string) => (id === "ag_1" ? "Teo 2" : id), docs: new Map() } as never;
  const town = (verb: string, input: unknown) => describeTool(world, `mcp__town__${verb}`, input);

  it("names queued work instead of a dangling 'to'", () => {
    expect(town("assign", { title: "Fix the bubbles" })).toBe("Queuing work: Fix the bubbles");
    expect(town("assign", { agentId: "ag_1", title: "Fix the bubbles" })).toBe("Assigning work to Teo 2: Fix the bubbles");
  });

  it("says what a review decision does", () => {
    expect(town("review", { decision: "approve" })).toBe("Approving a report");
    expect(town("review", { decision: "redirect" })).toBe("Redirecting a report's next step");
  });

  it("doesn't echo the log's placeholder title", () => {
    expect(town("write", { type: "log", title: "log" })).toBe("Writing a log line");
    expect(town("write", { type: "wiki", title: "Readable bubbles" })).toBe('Updating page "Readable bubbles"');
  });
});
