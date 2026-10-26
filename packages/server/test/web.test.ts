import { World } from "@muster-town/core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

describe("web client under /workshop/", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let world: World;
  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(dist, "assets", "x.js"), "console.log(1)");
    world = World.open(":memory:");
    app = await buildApp({ world, webDist: dist });
  });
  afterAll(async () => { await app.close(); world.close(); });
  const get = (url: string) => app.inject({ method: "GET", url });

  it("redirects the root to /workshop/, keeping the query", async () => {
    const r = await get("/");
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/workshop/");
    expect((await get("/?guest")).headers.location).toBe("/workshop/?guest");
  });

  it("serves the page and assets under the prefix only", async () => {
    expect((await get("/workshop")).headers.location).toBe("/workshop/");
    const page = await get("/workshop/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.body).toContain("<title>t</title>");
    expect((await get("/workshop/assets/x.js")).statusCode).toBe(200);
    expect((await get("/assets/x.js")).statusCode).toBe(404);
    const missing = await get("/workshop/assets/y.js");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("not_found");
  });

  it("SPA routes fall back to index.html under the prefix; other page paths go to /", async () => {
    const deep = await get("/workshop/dc_abc");
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("<title>t</title>");
    const other = await get("/somewhere");
    expect(other.statusCode).toBe(302);
    expect(other.headers.location).toBe("/");
    expect((await get("/api/health")).statusCode).toBe(200);
    expect((await get("/api/nope")).statusCode).toBe(404);
  });
});
