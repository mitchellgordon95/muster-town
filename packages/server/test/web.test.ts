import { World } from "@muster-town/core";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { collectives, PLACEHOLDER, renderHome } from "../src/home.ts";
const NOT_STARTED = "Not started yet: waiting for its founder's key.";

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
  beforeAll(() => {
    world = World.open(":memory:");
    world.town.set({ name: "Live Name", goal: "Live <goal>", tagline: "old tagline" });
  });
  afterAll(() => world.close());

  it("without hosted collectives: this server's entry from the live town row, then the placeholder", async () => {
    const app = await buildApp({ world, webDist: false });
    const { collectives } = (await app.inject("/api/collectives")).json();
    expect(collectives).toEqual([
      { slug: "workshop", name: "Live Name", goal: "Live <goal>", url: "/workshop/", started: true },
      { ...PLACEHOLDER },
    ]);
    const html = (await app.inject("/")).body;
    expect(html).toContain("Live Name");
    expect(html).toContain('<p class="tile-tag">Live &lt;goal&gt;</p>');
    // a collective's goal is its tagline: the town row's old tagline is not shown
    expect(html).not.toContain("old tagline");
    expect(html).toContain("Coming soon");
    // the placeholder gets no link: one tile link only; the embedded list can't close its script tag
    expect(html.match(/<a class="tile"/g)).toHaveLength(1);
    expect(html).toContain('"goal":"Live \\u003cgoal>"');
    // no web build: a bare page, no bundle tags
    expect(html).not.toContain('<script type="module"');
    await app.close();
  });

  // gr_a6512x0je1: a hosted collective that never ran a session says so and sorts after the ones that have
  it("a never-run hosted collective is listed after the ones that have run, with 'Not started yet' and no working-now pill", () => {
    const row = (slug: string, started: boolean) => ({ slug, name: slug, tagline: "", goal: `${slug} goal`, ownerGithubId: null, createdAt: "2026-11-01T00:00:00.000Z", state: "active" as const, started });
    const list = collectives(world, [row("quiet", false), row("busy", true)]);
    expect(list.map((c) => [c.slug, c.started])).toEqual([["workshop", true], ["busy", true], ["quiet", false]]);
    const html = renderHome(list);
    const tiles = html.split('<li class="tile-item">').slice(1);
    expect(tiles).toHaveLength(3);
    expect(tiles[1]).toContain('<span class="tile-live"></span>');
    expect(tiles[1]).not.toContain(NOT_STARTED);
    expect(tiles[2]).toContain('data-preview="/quiet/api/town"');
    expect(tiles[2]).not.toContain("tile-live");
    expect(tiles[2]).toContain(`<p class="tile-tag tile-wait">${NOT_STARTED}</p>`);
    expect(tiles[2]).toContain('<p class="tile-tag">quiet goal</p>');
    expect(html).toContain('"slug":"quiet","name":"quiet","goal":"quiet goal","url":"/quiet/","started":false');
    // with only never-run hosted collectives, they still replace the placeholder
    expect(collectives(world, [row("quiet", false)]).map((c) => c.slug)).toEqual(["workshop", "quiet"]);
  });

  // gr_rcj8nkbkbt (kr_ay5wb5wfhd): the signed-out landing carries the Uptime block's mount, with a no-JS link to the figures
  it("the homepage has an Uptime section linking /api/uptime", () => {
    const html = renderHome(collectives(world, []));
    expect(html).toContain('<div id="uptime" class="home-uptime">');
    expect(html).toContain('<a href="/api/uptime">/api/uptime</a>');
  });

  it("another collective dir lists itself by its own slug, opening here", async () => {
    const app = await buildApp({ world, webDist: false, collective: "garden" });
    const { collectives } = (await app.inject("/api/collectives")).json();
    expect(collectives.map((c: { slug: string; url: string }) => [c.slug, c.url])).toEqual([["garden", "/workshop/"], ["next", ""]]);
    expect((await app.inject("/")).body.match(/data-preview/g)).toHaveLength(1);
    await app.close();
  });
});
