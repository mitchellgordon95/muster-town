import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TownPublish } from "@muster-town/schema";
import { store } from "../src/state";
import { PublishToGitHub, publishLine, tokenPlaceholder, tokenSourceLine } from "../src/panels/BuildingPanel";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));

const P = (x: Partial<TownPublish> = {}): TownPublish => ({ repoUrl: "https://github.com/acme/town", tokenSet: true, lastPushAt: null, lastPushCommit: null, lastPushError: null, ...x });
const withTown = (publish?: TownPublish) => { store.state = { ...store.state, town: { name: "T", goal: "g", tagline: "", ...(publish ? { publish } : {}) } as never }; };

describe("Publish to GitHub block (gr_30f8obzab8)", () => {
  it("the last push line: none, never pushed, pushed, failed", () => {
    expect(publishLine(undefined)).toBeNull();
    expect(publishLine(P())).toEqual({ text: "No push yet: the next hourly export pushes.", bad: false });
    expect(publishLine(P({ lastPushAt: "2026-11-04T18:00:00Z", lastPushCommit: "abcdef1234567" }), () => "20m ago")).toEqual({ text: "Last push: 20m ago · abcdef1", bad: false });
    expect(publishLine(P({ lastPushAt: "2026-11-04T18:00:00Z", lastPushError: "rejected (fetch first)" }))).toEqual({ text: "Last push failed: rejected (fetch first)", bad: true });
  });

  it("the token is write-only: the field says set or not set, never the value", () => {
    expect(tokenPlaceholder(undefined)).toContain("GH_TOKEN");
    expect(tokenPlaceholder(P({ tokenSet: false }))).toContain("GH_TOKEN");
    expect(tokenPlaceholder(P())).toContain("set (leave blank");
  });

  it("says which token the push uses: its own, the collective's GH_TOKEN, or none", () => {
    expect(tokenSourceLine(undefined)).toBeNull();
    expect(tokenSourceLine(P({ tokenSource: "own" }))?.text).toContain("own token");
    expect(tokenSourceLine(P({ tokenSet: false, tokenSource: "collective" }))).toMatchObject({ bad: false, text: expect.stringContaining("GH_TOKEN") });
    expect(tokenSourceLine(P({ tokenSet: false, tokenSource: "none" }))?.bad).toBe(true);
  });

  it("renders unset (no Clear) and set (repo, Clear, line)", () => {
    withTown();
    const empty = renderToStaticMarkup(<PublishToGitHub />);
    expect(empty).toContain("Publish to GitHub");
    expect(empty).toContain("blank: use the collective");
    expect(empty).toContain("personal-access-tokens/new");
    expect(empty).not.toContain("Clear");
    expect(empty).not.toContain("No push yet");
    withTown(P({ lastPushAt: new Date().toISOString(), lastPushCommit: "0123456789" }));
    const set = renderToStaticMarkup(<PublishToGitHub />);
    expect(set).toContain('value="https://github.com/acme/town"');
    expect(set).toContain("Last push: just now · 0123456");
    expect(set).toContain("Clear");
    expect(set).toContain('type="password"');
  });
});
