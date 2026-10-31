import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { newId, nowIso } from "@muster-town/core";
import type { Session } from "@muster-town/schema";
import { grantedSecrets } from "../src/index.ts";
import { gitAuthEnv, repoToken } from "../src/desk/session.ts";
import { assertNoEnvCredentials, assertOneCredential, sessionEnv } from "../src/sdk.ts";
import type { Credential } from "@muster-town/core";
import type { Ctx } from "../src/session.ts";
import { result, setup } from "./helpers.ts";

afterEach(() => { vi.unstubAllEnvs(); });

describe("grantedSecrets (desk env)", () => {
  test("only granted collective secrets, a secret.granted event without the value, nothing from the host env", () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DESK_ENV_LEGACY", "legacy");
    const { world, lab } = setup(async function* () { yield result(0, 0); });
    const [a, b] = world.agents.where("homeBuildingId = ? AND kind = 'resident'", [lab.id]);
    const none = { buildings: [], agents: [], skills: [] };
    world.secrets.put("A_ONLY", { value: "for-a", grants: { ...none, agents: [a.id] } }, null);
    world.secrets.put("MINICLAW_WS_TOKEN", { value: "from-db", grants: { ...none, agents: [b.id] } }, null);
    const session = world.sessions.upsert({ id: newId("se"), agentId: a.id, assignmentId: null, meetingId: null, purpose: "work", backend: "docker", status: "running", model: "m", sdkSessionId: null, tokens: 0, costUsd: 0, startedAt: nowIso(), endedAt: null } as never) as Session;
    const env = grantedSecrets({ world } as Ctx, session, lab.id);
    // MINICLAW_WS_TOKEN is granted to b only, and the host's DESK_ENV_LEGACY no longer reaches any desk
    expect(env).toEqual({ A_ONLY: "for-a" });
    const events = world.events.list({ types: ["secret.granted"] });
    expect(events.map((e) => (e.payload as { name: string }).name)).toEqual(["A_ONLY"]);
    expect(events[0].payload).toMatchObject({ sessionId: session.id, via: "agent grant" });
    expect(JSON.stringify(events)).not.toMatch(/for-a/);
  });
});

describe("repoToken (the collective's GH_TOKEN secret, docs/secrets.md)", () => {
  test("the Town Hall secret wins over the host's; gitAuthEnv adds a credential helper only when the host configured none", () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("GH_TOKEN", "host-token");
    const { world } = setup(async function* () { yield result(0, 0); });
    expect(repoToken(world, "env")).toBe("host-token");
    expect(repoToken(world, "none")).toBeNull();
    world.secrets.put("GH_TOKEN", { value: "collective-token" }, null);
    expect(repoToken(world, "env")).toBe("collective-token");
    expect(gitAuthEnv(world, "none", {})).toMatchObject({ GH_TOKEN: "collective-token", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper" });
    expect(gitAuthEnv(world, "none", { GIT_CONFIG_COUNT: "1" })).toEqual({ GH_TOKEN: "collective-token" });
    world.secrets.delete("GH_TOKEN", null);
    expect(gitAuthEnv(world, "none", {})).toEqual({});
  });
});

describe("sessionEnv (host sessions)", () => {
  const host = { PATH: "/bin", HOME: "/h", LC_ALL: "C", MUSTER_TOWN_DATA_KEY: "dk", GITHUB_CLIENT_SECRET: "gs", DESK_ENV_OVH: "o", OVH_APPLICATION_SECRET: "o2", GH_TOKEN: "gh" } as NodeJS.ProcessEnv;
  const sub: Credential = { kind: "subscription", secret: "oat", inputId: "bi_1" };
  const key: Credential = { kind: "api-key", secret: "sk-donor", inputId: null };
  test("an allowlist of the host env, never its secrets, plus exactly one model credential: the Bank's", () => {
    expect(sessionEnv(sub, host)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "oat" });
    expect(sessionEnv(key, host)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", ANTHROPIC_API_KEY: "sk-donor" });
  });
  test("a credential in the host env is a second auth source and a hard failure (post-mortem 2026-10-30: the env's key was billed for eight days)", () => {
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      const env = { ...host, [k]: "x" } as NodeJS.ProcessEnv;
      expect(() => assertNoEnvCredentials(env)).toThrow(new RegExp(`${k} is set in the host env`));
      expect(() => sessionEnv(sub, env)).toThrow(/the Bank is the only place/);
    }
    expect(() => assertNoEnvCredentials({ ...host, CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set/);
    expect(() => assertNoEnvCredentials(host)).not.toThrow();
  });
  test("every session env carries exactly one credential variable: two, none, or a failover key beside one is a hard failure (1:1 mt_x40qq8poc3)", () => {
    expect(() => assertOneCredential({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).not.toThrow();
    expect(() => assertOneCredential({ ANTHROPIC_API_KEY: "k", PATH: "/bin" })).not.toThrow();
    expect(() => assertOneCredential({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toThrow(/exactly one model credential, not CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY/);
    expect(() => assertOneCredential({ CLAUDE_CODE_OAUTH_TOKEN: "t", AGENT_TOWN_FALLBACK_API_KEY: "k" })).toThrow(/not CLAUDE_CODE_OAUTH_TOKEN and AGENT_TOWN_FALLBACK_API_KEY/);
    expect(() => assertOneCredential({ MUSTER_TOWN_FALLBACK_API_KEY: "k" })).toThrow(/exactly one/);
    expect(() => assertOneCredential({ PATH: "/bin" })).toThrow(/this env has none/);
    expect(sessionEnv(sub, host)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "oat" });
  });
});
