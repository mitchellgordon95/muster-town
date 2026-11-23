import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeCommand, describeTool, GENERIC_LINES, LEAK } from "../src/describe.ts";

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

  it("names a file, not its path", () => {
    expect(describeTool(null as never, "Write", { file_path: "/home/agent/work/agent-town/packages/server/src/backup/restore.ts" })).toBe("Writing restore.ts");
    expect(describeTool(null as never, "Edit", { file_path: "/tmp/pw/bub.mjs" })).toBe("Editing bub.mjs");
    expect(describeTool(null as never, "Read", {})).toBe("Reading a file");
    // Grep and Glob show no folder and no slash (gr_93s00hyq1l step 2: seen live as "Grepping for /api/health")
    expect(describeTool(null as never, "Grep", { pattern: "/api/health" })).toBe("Searching for health API route");
    expect(describeTool(null as never, "Grep", { pattern: "captain|access", path: "/home/agent/x/packages/core/src/grants.ts" })).toBe("Searching grants.ts for captain, access");
    expect(describeTool(null as never, "Grep", { pattern: "$HOME" })).toBe("Searching files");
    expect(describeTool(null as never, "Glob", { pattern: "packages/core/src/*grant*" })).toBe("Looking for *grant*");
    expect(describeTool({ nameOf: (x: string) => x } as never, "mcp__town__submit_report", { title: "Subtree filter and GET /api/goals/:id/produced in packages/web/src/x.ts" }))
      .toBe("Submitting report: Subtree filter and GET goals API route in x.ts");
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
      ["FOO=1 BAR=2 node scripts/x.mjs", "Running x.mjs"],
      ["grep -rn describeTool packages/*/src | head", "Searching for describeTool"],
      ["rg -n foo", "Searching for foo"],
      ["ls packages/runtime/test", "Listing the test folder"],
      ["sed -i 's/a/b/' x.ts", "Editing x.ts"],
      ["sed -n 1,40p x.ts", "Reading x.ts"],
      ["cat > /tmp/x.json <<'EOF'\n{}\nEOF", "Writing x.json"],
      ["echo start; sleep 5; python3.11 -m pytest -q", "Running tests"],
      ["echo hello", "Printing a note"],
      ["timeout 60 /usr/bin/python3 run.py", "Running run.py"],
      ["bash -c 'npm run build'", "Building the code"],
      ["cd /tmp", "Running a shell command"],
      ["./some-tool --flag /secret/path", "Running a shell command"],
      ["", "Running a shell command"],
    ];
    for (const [cmd, want] of cases) expect(describeCommand(cmd), cmd).toBe(want);
  });

  it("names the file or the search term, never its folders (gr_93s00hyq1l)", () => {
    const cases: [string, string][] = [
      ["sed -n 1,70p packages/core/src/jobs.ts; sed -n 140,240p packages/core/src/jobs.ts", "Reading jobs.ts"],
      ["cat packages/server/src/routes/asks.ts && sed -n 1,120p packages/core/src/asks.ts", "Reading asks.ts"],
      ["head -40 packages/core/src/goal-spend.ts", "Reading goal-spend.ts"],
      ["tail -n 20 /tmp/tc.log", "Reading tc.log"],
      [`grep -rn "captainRequests\\|accessRequests" packages/web/src | head -8`, "Searching for captainRequests, accessRequests"],
      [`grep -n "^export function townFinance" -A12 packages/core/src/finance.ts`, "Searching finance.ts for export function townFinance"],
      [`grep -rn "CREATE TABLE.*doc_revisions" packages/core/src/*.ts`, "Searching for CREATE TABLE doc_revisions"],
      [`grep -rn "grantDesk.list(" packages/core/test`, "Searching for grantDesk.list"],
      [`git grep -n "objective" -- 'packages/web/src/*.tsx'`, "Searching for objective"],
      [`find packages -name "intray-routes.ts" -not -path "*/node_modules/*"`, "Looking for intray-routes.ts"],
      ["sed -i 's/var(--blue, var(--green))/var(--blue)/' packages/web/src/home/home.css", "Editing home.css"],
      ["ls -d packages/*/migrations", "Listing the migrations folder"],
      ["ls packages/runtime/src/*.test.ts", "Listing *.test.ts"],
      ["mkdir -p /tmp/shot && cat > /tmp/shot/go.mjs <<'EOF'\nconsole.log(1)\nEOF", "Writing go.mjs"],
      ["mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core", "Installing packages"],
      ["python3 - <<'EOF'\np='packages/web/src/panels/GrantPanel.tsx'\ns=open(p).read()\nEOF", "Running a Python script on GrantPanel.tsx"],
      ["python3 - <<'EOF'\nimport json,urllib.request\nd=json.load(urllib.request.urlopen('https://muster.town/api/events'))\nEOF", "Calling the town API"],
      ["node /tmp/shot/go.mjs", "Running go.mjs"],
      ["timeout 90 chromium --headless=new --no-sandbox --screenshot=/tmp/a.png https://muster.town/", "Taking a screenshot"],
      [`until grep -q "total" /tmp/out.txt; do sleep 5; done`, "Searching out.txt for total"],
    ];
    for (const [cmd, want] of cases) expect(describeCommand(cmd), cmd).toBe(want);
  });

  it("keeps the generic line when the term or name is not safe to show", () => {
    expect(describeCommand(`grep -rn "/api/jobs/:id" packages/server/src`)).toBe("Searching for jobs API route");
    expect(describeCommand(`grep -rn "/api/jobs" packages/server/src/app.ts`)).toBe("Searching app.ts for jobs API route");
    expect(describeCommand(`grep -n "/data/repo" x.ts`)).toBe("Searching x.ts");
    expect(describeCommand(`grep -rln 'api/asks/' test`)).toBe("Searching for asks API route");
    expect(describeCommand(`grep -n "Redeploy\\b\\|redeploy" architecture.md`)).toBe("Searching architecture.md for Redeploy, redeploy");
    expect(describeCommand(`grep -n "TOKEN=abc" .env`)).toBe("Searching files");
    expect(describeCommand(`grep ghp_abcdefghijklmnop x`)).toBe("Searching files");
    expect(describeCommand(`grep -c "$HOME" notes`)).toBe("Searching files");
    expect(describeCommand("cat /dev/null")).toBe("Reading files");
    expect(describeCommand("ls ~")).toBe("Listing files");
  });

  it("splits at operators outside quotes only", () => {
    expect(describeCommand(`grep -n "a | b; c && d" x.ts`)).toBe("Searching x.ts for a, b; c && d");
  });

  it("labels the real corpus: most lines name something, none leaks a path or an env var", () => {
    const { commands } = JSON.parse(readFileSync(new URL("./fixtures/bash-commands.json", import.meta.url), "utf8")) as { commands: { command: string; label: string }[] };
    expect(commands.length).toBeGreaterThanOrEqual(100);
    let generic = 0;
    for (const { command, label } of commands) {
      const got = describeCommand(command);
      expect(got, command).toBe(label);
      expect(got, command).not.toMatch(LEAK);
      if (GENERIC_LINES.has(got)) generic++;
    }
    expect(generic / commands.length).toBeLessThanOrEqual(0.25);
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

describe("an agent's own Bash description", () => {
  it("keeps its words but cuts full paths to the file's name", () => {
    expect(describeTool(null as never, "Bash", { command: "x", description: "Run tests in packages/web/test/askCard.test.tsx" })).toBe("Running: Run tests in askCard.test.tsx");
    expect(describeTool(null as never, "Bash", { command: "x", description: "Read /tmp/tc.log and/or retry" })).toBe("Running: Read tc.log and/or retry");
  });
});
