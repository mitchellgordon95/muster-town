import { World } from "@muster-town/core";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectiveRegistry } from "@muster-town/schema";
import { buildApp } from "../src/app.ts";
import { DEFAULT_REGISTRY } from "../src/home.ts";

describe("web client under /workshop/", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let world: World;
  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(dist, "assets", "x.js"), "console.log(1)");
    writeFileSync(join(dist, "home.html"), '<!doctype html><head><title>h</title><script type="module" crossorigin src="/workshop/assets/home-1.js"></script>\n<link rel="stylesheet" crossorigin href="/workshop/assets/home-1.css"></head><body></body>');
    world = World.open(":memory:");
    app = await buildApp({ world, webDist: dist });
  });
  afterAll(async () => { await app.close(); world.close(); });
  const get = (url: string) => app.inject({ method: "GET", url });

  it("the root is the homepage; a query still goes to /workshop/", async () => {
    const r = await get("/");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.body).toContain('href="/workshop/"');
    expect(r.body).toContain("location.replace(\"/workshop/\" + location.hash)");
    // the homepage bundle's tags come from the built home.html; the tile for this server's town gets a live preview
    expect(r.body).toContain('<script type="module" crossorigin src="/workshop/assets/home-1.js"></script>');
    expect(r.body).toContain('<link rel="stylesheet" crossorigin href="/workshop/assets/home-1.css">');
    expect(r.body).toContain('data-preview="/api/town"');
    expect((await get("/?guest")).headers.location).toBe("/workshop/?guest");
    expect((await get("/?as=visitor")).headers.location).toBe("/workshop/?as=visitor");
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

describe("collectives homepage and /api/collectives", () => {
  let world: World;
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  const reg = join(dir, "registry.json");
  beforeAll(() => {
    world = World.open(":memory:");
    world.town.set({ name: "Live Name", goal: "Live goal", tagline: "live <tagline>" });
  });
  afterAll(() => world.close());
  const build = (registry: string) => buildApp({ world, webDist: false, registry });

  it("the checked-in registry parses and lists the Workshop plus a placeholder", () => {
    const { collectives } = CollectiveRegistry.parse(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")));
    expect(collectives.find((c) => c.url === "/workshop/")).toBeTruthy();
    expect(collectives.some((c) => c.placeholder)).toBe(true);
  });

  it("lists the registry, with this server's entry from the live town row", async () => {
    writeFileSync(reg, JSON.stringify({ collectives: [
      { slug: "workshop", name: "Old", tagline: "old", goal: "old", url: "/workshop/" },
      { slug: "next", name: "Your collective here", tagline: "soon", placeholder: true },
    ] }));
    const app = await build(reg);
    const { collectives } = (await app.inject("/api/collectives")).json();
    expect(collectives).toEqual([
      { slug: "workshop", name: "Live Name", tagline: "live <tagline>", goal: "Live goal", url: "/workshop/" },
      { slug: "next", name: "Your collective here", tagline: "soon", goal: "", url: "", placeholder: true },
    ]);
    const html = (await app.inject("/")).body;
    expect(html).toContain("Live Name");
    expect(html).toContain("live &lt;tagline&gt;");
    expect(html).toContain("Coming soon");
    // the placeholder gets no link: one tile link only; the embedded list can't close its script tag
    expect(html.match(/<a class="tile"/g)).toHaveLength(1);
    expect(html).toContain('"tagline":"live \\u003ctagline>"');
    // no web build: a bare page, no bundle tags
    expect(html).not.toContain('<script type="module"');
    await app.close();
  });

  it("a second collective matches its own entry by slug: listed once, opening here; the Workshop's relative url is left out", async () => {
    writeFileSync(reg, JSON.stringify({ collectives: [
      { slug: "workshop", name: "Workshop Collective", url: "/workshop/" },
      { slug: "garden", name: "Old", url: "http://localhost:4323/workshop/" },
      { slug: "far", name: "Far", url: "https://far.example/workshop/" },
    ] }));
    const app = await buildApp({ world, webDist: false, registry: reg, collective: "garden" });
    const { collectives } = (await app.inject("/api/collectives")).json();
    expect(collectives.map((c: { slug: string; name: string; url: string }) => [c.slug, c.name, c.url])).toEqual([
      ["garden", "Live Name", "/workshop/"],
      ["far", "Far", "https://far.example/workshop/"],
    ]);
    expect((await app.inject("/")).body.match(/data-preview/g)).toHaveLength(1);
    await app.close();
  });

  it("a missing or invalid registry lists just this server's collective", async () => {
    for (const path of [join(dir, "nope.json"), reg]) {
      if (path === reg) writeFileSync(reg, "{ not json");
      const app = await build(path);
      const { collectives } = (await app.inject("/api/collectives")).json();
      expect(collectives).toEqual([{ slug: "workshop", url: "/workshop/", name: "Live Name", tagline: "live <tagline>", goal: "Live goal" }]);
      await app.close();
    }
  });
});
