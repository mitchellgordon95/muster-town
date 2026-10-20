import { describe, it, expect } from "vitest";
import { httpsRepoUrl } from "../src/prompts.ts";

describe("httpsRepoUrl", () => {
  it("rewrites ssh remotes to https and leaves https alone", () => {
    expect(httpsRepoUrl("git@github.com:mitchellgordon95/agent-town.git")).toBe("https://github.com/mitchellgordon95/agent-town.git");
    expect(httpsRepoUrl("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
    expect(httpsRepoUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
  });
});
