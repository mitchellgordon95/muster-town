import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { newId, nowIso } from "@muster-town/core";
import type { Session } from "@muster-town/schema";
import { grantedSecrets } from "../src/index.ts";
import { gitAuthEnv, repoToken } from "../src/desk/session.ts";
import { sessionEnv } from "../src/sdk.ts";
import type { Ctx } from "../src/session.ts";
import { result, setup } from "./helpers.ts";

afterEach(() => { vi.unstubAllEnvs(); });

describe("grantedSecrets (desk env)", () => {
  test("only granted collective secrets, a secret.granted event without the value, DESK_ENV_* only for unmanaged names", () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("base64"));
    const { world, lab } = setup(async function* () { yield result(0, 0); });
    const [a, b] = world.agents.where("homeBuildingId = ? AND kind = 'resident'", [lab.id]);
    const none = { buildings: [], agents: [], skills: [] };
    world.secrets.put("A_ONLY", { value: "for-a", grants: { ...none, agents: [a.id] } }, null);
    world.secrets.put("MINICLAW_WS_TOKEN", { value: "from-db", grants: { ...none, agents: [b.id] } }, null);
    const session = world.sessions.upsert({ id: newId("se"), agentId: a.id, assignmentId: null, meetingId: null, purpose: "work", backend: "docker", status: "running", model: "m", sdkSessionId: null, tokens: 0, costUsd: 0, startedAt: nowIso(), endedAt: null } as never) as Session;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = grantedSecrets({ world } as Ctx, session, lab.id, { DESK_ENV_LEGACY: "legacy", DESK_ENV_MINICLAW_WS_TOKEN: "host-copy", PATH: "/bin" });
    // the DB manages MINICLAW_WS_TOKEN (granted to b only), so the host's DESK_ENV_ copy doesn't leak to a
    expect(env).toEqual({ A_ONLY: "for-a", LEGACY: "legacy" });
    expect(warn.mock.calls.join(" ")).toMatch(/LEGACY.*deprecated/);
    const events = world.events.list({ types: ["secret.granted"] });
    expect(events.map((e) => (e.payload as { name: string }).name).sort()).toEqual(["A_ONLY", "LEGACY"]);
    expect(events[0].payload).toMatchObject({ sessionId: session.id });
    expect(JSON.stringify(events)).not.toMatch(/for-a|legacy"/);
    warn.mockRestore();
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
  test("an allowlist of the host env, never its secrets", () => {
    const host = { PATH: "/bin", HOME: "/h", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "k", MUSTER_TOWN_DATA_KEY: "dk", GITHUB_CLIENT_SECRET: "gs", DESK_ENV_OVH: "o", OVH_APPLICATION_SECRET: "o2", GH_TOKEN: "gh" } as NodeJS.ProcessEnv;
    expect(sessionEnv(null, host)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "k" });
    expect(sessionEnv("donor", host).ANTHROPIC_API_KEY).toBe("donor");
  });
});
