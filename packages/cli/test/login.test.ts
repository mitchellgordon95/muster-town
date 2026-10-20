import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { login } from "../src/login.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/index.ts");
const TSX = resolve(HERE, "../../../node_modules/.bin/tsx");

/** One server playing both GitHub (device flow) and the town (config + device endpoint). */
let server: Server;
let url = "";
let home = "";
let polls = 0;
let clientId: string | null = "Iv1.public";
let deviceFlow = true;
const seen: { path: string; body: any }[] = [];

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : undefined); } catch { ok(s); } }); });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? "";
    seen.push({ path, body });
    const send = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    if (path === "/api/auth/config") return send(200, { githubClientId: clientId, publicUrl: url });
    if (path === "/login/device/code") {
      if (!deviceFlow) return send(400, { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" });
      return send(200, { device_code: "dev123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 });
    }
    if (path === "/login/oauth/access_token") {
      polls++;
      if (body.device_code !== "dev123" || body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return send(200, { error: "bad_request" });
      return send(200, polls < 3 ? { error: "authorization_pending" } : { access_token: "gho_cli", token_type: "bearer" });
    }
    if (path === "/api/auth/github/device") {
      if (body?.accessToken !== "gho_cli") return send(401, { error: "GitHub rejected the token (401).", code: "unauthorized" });
      return send(200, { token: "tok_town_user", user: { id: "us_1", name: "Octo", githubLogin: "octo", createdAt: "2026-10-20T00:00:00Z", donatedTokens: 0, hasApiKey: false } });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-town-login-"));
  process.env.AGENT_TOWN_HOME = home;
  polls = 0; clientId = "Iv1.public"; deviceFlow = true; seen.length = 0;
  return () => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENT_TOWN_HOME; };
});

describe("muster-town login", () => {
  it("runs the device flow, polls through authorization_pending, and saves the town token (mode 600)", async () => {
    const out: string[] = [];
    const r = await login({ url, profile: "user" }, { githubUrl: url, sleep: async () => undefined, print: (s) => out.push(s) });
    expect(out[0]).toBe("Open https://github.com/login/device and enter the code: ABCD-1234");
    expect(out).toContain("logged in as octo");
    expect(polls).toBe(3);
    expect(seen.find((s) => s.path === "/login/device/code")!.body).toEqual({ client_id: "Iv1.public", scope: "read:user" });
    expect(seen.find((s) => s.path === "/api/auth/github/device")!.body).toEqual({ accessToken: "gho_cli" });
    expect(r.path).toBe(join(home, "user.env"));
    expect(readFileSync(r.path, "utf8")).toContain("AGENT_TOWN_TOKEN=tok_town_user");
    expect(readFileSync(r.path, "utf8")).not.toContain("gho_cli");
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
  });

  it("explains a server without GitHub login, and a GitHub app without device flow", async () => {
    clientId = null;
    await expect(login({ url, profile: "user" }, { githubUrl: url, sleep: async () => undefined, print: () => undefined })).rejects.toThrow(/GITHUB_CLIENT_ID/);
    clientId = "Iv1.public"; deviceFlow = false;
    await expect(login({ url, profile: "user" }, { githubUrl: url, sleep: async () => undefined, print: () => undefined })).rejects.toThrow(/Enable Device Flow/);
  });

  it("works end to end as a command, with --profile", async () => {
    const res = await new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
      execFile(TSX, [CLI, "login", "--profile", "me", "--url", url], { env: { ...process.env, AGENT_TOWN_HOME: home, AGENT_TOWN_GITHUB_URL: url, AGENT_TOWN_TOKEN: "" }, timeout: 20_000 },
        (err, stdout, stderr) => ok({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }));
    });
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/ABCD-1234/);
    expect(res.stdout).toMatch(/logged in as octo/);
    expect(readFileSync(join(home, "me.env"), "utf8")).toContain(`AGENT_TOWN_URL=${url}`);
  }, 30_000);
});
