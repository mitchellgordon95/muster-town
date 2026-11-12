import { World } from "@muster-town/core";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { blogRoutes } from "../src/blog.ts";

const ORIGIN = "https://example.town";
const post = (fm: string, body = "Hello **world**.") => `---\n${fm}\n---\n\n${body}\n`;

async function blogApp(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "blog-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const app = Fastify();
  await app.register(blogRoutes(ORIGIN, dir));
  return app;
}

describe("blog", () => {
  it("says there are no posts when the folder is empty or missing", async () => {
    const app = Fastify();
    await app.register(blogRoutes(ORIGIN, join(tmpdir(), "no-such-blog-dir")));
    const res = await app.inject("/blog");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("No posts yet.");
  });

  it("lists public posts newest first and renders a post with its preview tags", async () => {
    const app = await blogApp({
      "older.md": post("title: Older post\ndate: 2026-11-01\nauthor: Mitchell\nsummary: The first one."),
      "newer.md": post('title: "Newer <post>"\ndate: 2026-11-10\nsummary: The second one.'),
    });
    const index = (await app.inject("/blog")).body;
    expect(index.indexOf("/blog/newer")).toBeGreaterThan(-1);
    expect(index.indexOf("/blog/newer")).toBeLessThan(index.indexOf("/blog/older"));
    expect(index).toContain("Newer &lt;post&gt;");
    expect(index).toContain("The first one.");

    const res = await app.inject("/blog/older");
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain("<title>Older post</title>");
    expect(html).toContain('<meta name="description" content="The first one.">');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/blog/older">`);
    expect(html).toContain('<meta property="og:title" content="Older post">');
    expect(html).toContain('<meta property="og:description" content="The first one.">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/blog/older">`);
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain(`<link rel="alternate" type="application/atom+xml" title="Muster Town blog" href="${ORIGIN}/blog/feed.xml">`);
    expect(html).toContain("Hello <strong>world</strong>.");
    expect(html).toContain("<!-- signup:");
  });

  it("serves a draft at its URL but leaves it out of the index and the feed", async () => {
    const app = await blogApp({
      "live.md": post("title: Live\ndate: 2026-11-02"),
      "secret.md": post("title: Secret draft\ndate: 2026-11-11\ndraft: true"),
    });
    const draft = await app.inject("/blog/secret");
    expect(draft.statusCode).toBe(200);
    expect(draft.body).toContain("<title>Secret draft</title>");
    expect((await app.inject("/blog")).body).not.toContain("secret");
    const feed = (await app.inject("/blog/feed.xml")).body;
    expect(feed).toContain(`${ORIGIN}/blog/live`);
    expect(feed).not.toContain("secret");
  });

  it("answers an unknown, malformed or front-matter-less slug with a 404 page", async () => {
    const app = await blogApp({ "bare.md": "no front matter here\n" });
    for (const url of ["/blog/nope", "/blog/bare", "/blog/..%2Fsecret", "/blog/UPPER"]) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("Post not found");
    }
  });

  it("serves a well-formed Atom feed", async () => {
    const app = await blogApp({ "a.md": post("title: A & B\ndate: 2026-11-03\nauthor: Juno\nsummary: <x>") });
    const res = await app.inject("/blog/feed.xml");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/atom\+xml/);
    const xml = res.body;
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<title>A &amp; B</title>");
    expect(xml).toContain("<summary>&lt;x&gt;</summary>");
    expect(xml).toContain("<updated>2026-11-03T00:00:00Z</updated>");
    // every tag opened is closed, in order
    const stack: string[] = [];
    for (const [, close, name, self] of xml.replace(/<\?xml[^>]*\?>/, "").matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (self) continue;
      if (close) expect(stack.pop()).toBe(name);
      else stack.push(name!);
    }
    expect(stack).toEqual([]);
  });

  it("is mounted on the root app, ahead of the SPA's redirect to /", async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: dist });
    expect((await app.inject("/blog")).statusCode).toBe(200);
    expect((await app.inject("/blog/feed.xml")).statusCode).toBe(200);
    expect((await app.inject("/blog/hello-from-muster-town")).body).toContain("Hello from Muster Town");
    expect((await app.inject("/blog/no-such-post")).statusCode).toBe(404);
    expect((await app.inject("/elsewhere")).statusCode).toBe(302);
    await app.close();
    world.close();
  });
});
