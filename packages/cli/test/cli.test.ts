import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/index.ts");
const TSX = resolve(HERE, "../../../node_modules/.bin/tsx");
const AGENT = "tok_agent_secret";
const USER = "tok_user_secret";

interface Seen { method: string; path: string; auth: string | undefined; body: unknown }
let seen: Seen[] = [];
let digest: unknown = null;

const look = {
  me: { id: "ag_me", name: "Wren", status: "working", buildingId: "workshop", place: "desk:ag_me", pos: { x: 3, y: 4 } },
  building: { id: "workshop", name: "Town Workshop", goal: "Build the town" },
  nearby: [{ id: "ag_pix", name: "Pix", kind: "agent", status: "working", activity: "editing the map", distance: 2 }],
  notices: { unread: 2, mentions: 1, pendingAssignments: 0, currentAssignment: "Fix the CLI", nextMeeting: null },
  places: [{ id: "library", name: "Library", kind: "library" }, { id: "board:workshop", name: "Board", kind: "board" }],
};
const inbox = {
  messages: [
    { id: "m1", kind: "tell", from: "Pix", fromId: "ag_pix", body: "older message", meetingId: null, docId: null, at: "2026-10-20T10:00:00.000Z" },
    { id: "m2", kind: "mention", from: "Mitchell", fromId: "us_m", body: "newer: look at this", meetingId: null, docId: "doc_9", at: "2026-10-20T12:00:00.000Z" },
  ],
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { ok(s ? JSON.parse(s) : undefined); } catch { ok(s); } });
  });
}

let server: Server;
let url = "";
let home = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });
    const send = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    const auth = req.headers.authorization;
    if (req.method === "GET" && path === "/api/verbs") return send(200, { verbs: [{ name: "look", description: "Where am I", inputSchema: {} }, { name: "tell", description: "Send a message", inputSchema: {} }] });
    if (req.method === "POST" && path === "/api/agents/visitors") {
      if (auth !== `Bearer ${USER}`) return send(401, { error: "user token required", code: "unauthorized" });
      return send(200, { agent: { id: "ag_new", name: (body as { name: string }).name, buildingId: "workshop" }, token: "tok_new_agent_secret" });
    }
    if (auth !== `Bearer ${AGENT}`) return send(401, { error: "bad token", code: "unauthorized" });
    if (req.method === "GET" && path === "/api/agents/me/digest") return send(200, digest);
    const m = path.match(/^\/api\/verbs\/([a-z_]+)$/);
    if (req.method === "POST" && m) {
      const verb = m[1];
      if (verb === "look") return send(200, { result: look });
      if (verb === "inbox") return send(200, { result: inbox });
      if (verb === "read") return send(404, { error: "No such doc: doc_missing", code: "not_found" });
      if (verb === "nope") return send(404, { error: "Unknown verb nope", code: "unknown_verb" });
      return send(200, { result: { echo: body } });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), "agent-town-cli-"));
});

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { seen = []; digest = null; });

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const base: Record<string, string | undefined> = { ...process.env, AGENT_TOWN_HOME: home, AGENT_TOWN_URL: url, AGENT_TOWN_TOKEN: AGENT };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete base[k]; else base[k] = v;
  return new Promise((ok) => {
    execFile(TSX, [CLI, ...args], { env: base as NodeJS.ProcessEnv, timeout: 20_000 }, (err, stdout, stderr) => {
      ok({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const lastVerb = () => seen.filter((s) => s.path.startsWith("/api/verbs/")).at(-1)!;

describe("verb flags", () => {
  it("tell --to --text posts the input with the agent token", async () => {
    const r = await run(["tell", "--to", "ag_x", "--text", "hi"]);
    expect(r.code).toBe(0);
    const s = lastVerb();
    expect(s.path).toBe("/api/verbs/tell");
    expect(s.auth).toBe(`Bearer ${AGENT}`);
    expect(s.body).toEqual({ to: "ag_x", text: "hi" });
  });

  it("search --query --limit converts numbers and kebab-case flags", async () => {
    const r = await run(["search", "--query", "x", "--limit", "5", "--building-id", "workshop", "--json-out"]);
    expect(r.code).toBe(0);
    expect(lastVerb().body).toEqual({ query: "x", limit: 5, buildingId: "workshop" });
    expect(JSON.parse(r.stdout)).toEqual({ echo: { query: "x", limit: 5, buildingId: "workshop" } });
  });

  it("--json is the input; flags override its fields", async () => {
    const r = await run(["write", "--json", '{"title":"T","body":"B","tags":["a"]}', "--title", "T2", "--tags", "x", "--tags", "y"]);
    expect(r.code).toBe(0);
    expect(lastVerb().body).toEqual({ title: "T2", body: "B", tags: ["x", "y"] });
  });

  it("booleans take --no-x, objects take JSON", async () => {
    await run(["inbox", "--no-mark-read"]);
    expect(lastVerb().body).toEqual({ markRead: false });
    await run(["write", "--title", "t", "--body", "b", "--provenance", '{"urls":["https://x"]}']);
    expect(lastVerb().body).toMatchObject({ provenance: { urls: ["https://x"] } });
  });

  it("call <verb> <json> reaches any verb", async () => {
    const r = await run(["call", "board", '{"limit":3}', "--json-out"]);
    expect(r.code).toBe(0);
    expect(lastVerb()).toMatchObject({ path: "/api/verbs/board", body: { limit: 3 } });
  });

  it("missing required flags and bad numbers fail with exit 2 before any request", async () => {
    const a = await run(["tell", "--to", "ag_x"]);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain("--text");
    const b = await run(["search", "--query", "x", "--limit", "five"]);
    expect(b.code).toBe(2);
    expect(seen.length).toBe(0);
  });
});

describe("readable output", () => {
  it("look prints identity, building, notices, nearby", async () => {
    const r = await run(["look"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Wren (ag_me) · working · Town Workshop [workshop] at desk:ag_me");
    expect(r.stdout).toContain("2 unread, 1 mentions");
    expect(r.stdout).toContain("Current assignment: Fix the CLI");
    expect(r.stdout).toMatch(/Pix\s+ag_pix.*editing the map/);
    expect(r.stdout).toContain("Places: library, board:workshop");
  });

  it("inbox prints messages newest first with doc refs", async () => {
    const r = await run(["inbox"]);
    expect(r.code).toBe(0);
    expect(r.stdout.indexOf("newer: look at this")).toBeLessThan(r.stdout.indexOf("older message"));
    expect(r.stdout).toContain("mention from Mitchell (us_m) · doc doc_9");
  });

  it("whoami prints identity and building, never the token", async () => {
    const r = await run(["whoami"]);
    expect(r.stdout).toContain("Wren (ag_me) · working");
    expect(r.stdout).toContain("Building: Town Workshop [workshop]");
    expect(r.stdout + r.stderr).not.toContain(AGENT);
  });

  it("digest prints sections, or a note when null", async () => {
    let r = await run(["digest"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No digest");
    digest = { offlineSince: "2026-10-19T08:00:00.000Z", messages: 3, mentions: 1, assignmentsOffered: 0, meetingsMissed: [{ id: "mt_1", title: "Standup", notesDocId: "doc_n" }] };
    r = await run(["digest"]);
    expect(r.stdout).toContain("Since 2026-10-19 08:00Z");
    expect(r.stdout).toContain("Messages: 3  (agent-town inbox)");
    expect(r.stdout).toContain("Assignments offered: 0");
    expect(r.stdout).toContain("agent-town read --id doc_n");
  });

  it("verbs lists the server's verbs", async () => {
    const r = await run(["verbs"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/look\s+Where am I/);
  });
});

describe("profiles", () => {
  it("register --profile writes a mode-600 env file and doesn't print the token", async () => {
    const r = await run(["register", "--name", "Wren", "--profile", "wren"], { AGENT_TOWN_TOKEN: USER });
    expect(r.code).toBe(0);
    const p = join(home, "wren.env");
    expect(readFileSync(p, "utf8")).toContain("AGENT_TOWN_TOKEN=tok_new_agent_secret");
    expect(readFileSync(p, "utf8")).toContain(`AGENT_TOWN_URL=${url}`);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain("tok_new_agent_secret");
    expect(r.stdout).toContain("--profile wren");
  });

  it("--profile reads the token and URL from the file, over the environment", async () => {
    writeFileSync(join(home, "p1.env"), `# comment\nexport AGENT_TOWN_URL="${url}"\nAGENT_TOWN_TOKEN=${AGENT}\n`);
    const r = await run(["look", "--profile", "p1"], { AGENT_TOWN_TOKEN: "wrong", AGENT_TOWN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(0);
    expect(lastVerb().auth).toBe(`Bearer ${AGENT}`);
  });

  it("falls back to the default profile when AGENT_TOWN_TOKEN is unset", async () => {
    writeFileSync(join(home, "default.env"), `AGENT_TOWN_URL=${url}\nAGENT_TOWN_TOKEN=${AGENT}\n`);
    const r = await run(["look"], { AGENT_TOWN_TOKEN: undefined, AGENT_TOWN_URL: undefined });
    expect(r.code).toBe(0);
    rmSync(join(home, "default.env"));
  });

  it("a missing profile is an error", async () => {
    const r = await run(["look", "--profile", "ghost"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('No profile "ghost"');
  });
});

describe("errors", () => {
  it("prints the server's error and exits 1, without the token", async () => {
    const r = await run(["read", "--id", "doc_missing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error 404 (not_found): No such doc: doc_missing");
    expect(r.stderr).not.toContain(AGENT);
  });

  it("bad token → 401 message, exit 1", async () => {
    const r = await run(["look"], { AGENT_TOWN_TOKEN: "nope" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bad token");
  });

  it("no token at all → exit 2 with a hint", async () => {
    const r = await run(["look"], { AGENT_TOWN_TOKEN: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("AGENT_TOWN_TOKEN");
  });

  it("unreachable server → exit 1", async () => {
    const r = await run(["look"], { AGENT_TOWN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Can't reach");
  });
});
