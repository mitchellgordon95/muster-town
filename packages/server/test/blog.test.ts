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
    expect(html).toContain(`<form class="signup"`);
  });

  it("puts the email signup at the foot of each post and of the index, tagged with where it was", async () => {
    const app = await blogApp({ "older.md": post("title: Older post\ndate: 2026-11-01") });
    const html = (await app.inject("/blog/older")).body;
    expect(html).toContain('<form class="signup" method="post" action="/api/blog/subscribe" data-source="older">');
    expect(html).toContain("New posts by email. Nothing else.");
    expect(html.indexOf('class="signup"')).toBeGreaterThan(html.indexOf("</article>"));
    expect((await app.inject("/blog")).body).toContain('data-source="index"');
  });

  it("shows a post's upcoming list as the signup hook, on the post and on the index", async () => {
    const app = await blogApp({
      "older.md": post("title: Older\ndate: 2026-11-01"),
      "next.md": post("title: Next\ndate: 2026-11-19\nupcoming:\n  - the operating layers (jobs + queues)\n  - using <Bend> 2\nauthor: Mitchell"),
    });
    const html = (await app.inject("/blog/next")).body;
    expect(html).toContain("<p>Coming next:</p>\n<ul>\n<li>the operating layers (jobs + queues)</li>\n<li>using &lt;Bend&gt; 2</li>\n</ul>");
    expect(html).toContain("Subscribe for updates (mailing list for every blog post)");
    expect(html).not.toContain("New posts by email. Nothing else.");
    expect(html).toContain("· Mitchell"); // a key after the list is still read
    expect((await app.inject("/blog")).body).toContain("<li>using &lt;Bend&gt; 2</li>");
    const older = (await app.inject("/blog/older")).body;
    expect(older).toContain("New posts by email. Nothing else.");
    expect(older).not.toContain("Coming next:");
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

  it("counts each browser read of a public post with its source (gr_ox3fmliv9n); bots, HEAD, drafts and missing posts never count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blog-"));
    writeFileSync(join(dir, "live.md"), post("title: Live\ndate: 2026-11-10"));
    writeFileSync(join(dir, "wip.md"), post("title: Wip\ndate: 2026-11-10\ndraft: true"));
    const reads: [string, string][] = [];
    const app = Fastify();
    await app.register(blogRoutes(ORIGIN, dir, (slug, source) => reads.push([slug, source])));
    const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36";
    await app.inject({ url: "/blog/live", headers: { "user-agent": ua, referer: "https://news.ycombinator.com/item?id=42" } });
    await app.inject({ url: "/blog/live?ref=Discord", headers: { "user-agent": ua, referer: "https://news.ycombinator.com/" } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": ua, referer: `${ORIGIN}/blog` } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": "curl/8.5.0" } });
    await app.inject({ method: "HEAD", url: "/blog/live", headers: { "user-agent": ua } });
    await app.inject({ url: "/blog/wip", headers: { "user-agent": ua } });
    await app.inject({ url: "/blog/nope", headers: { "user-agent": ua } });
    expect(reads).toEqual([["live", "news.ycombinator.com"], ["live", "ref:discord"], ["live", "direct"]]);
  });

  it("the root app's blog reads and homepage sources show on GET /api/join-funnel", async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: dist });
    const ua = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36" };
    await app.inject({ url: "/blog/hello-from-muster-town", headers: ua }); // a draft: never counted
    await app.inject({ url: "/blog/engineering-human-oversight-with-decision-queues", headers: { ...ua, referer: "https://news.ycombinator.com/" } });
    const home = (body: object) => app.inject({ method: "POST", url: "/api/join-funnel/home", headers: { ...ua, host: "muster.town" }, payload: body });
    expect((await home({ visitor: "visitor-from-hn-1", referrer: "https://news.ycombinator.com/item?id=1" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-tagged-01", ref: "test", referrer: "https://muster.town/blog" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-internal1", referrer: "https://muster.town/blog" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-from-hn-1", step: "page2" })).json()).toEqual({ counted: true }); // a step carries no source
    const f = (await app.inject("/api/join-funnel")).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(f.blogReads).toEqual([{ day: today, slug: "engineering-human-oversight-with-decision-queues", source: "news.ycombinator.com", count: 1 }]);
    expect(f.sources).toEqual(expect.arrayContaining([
      { day: today, step: "homeViews", source: "news.ycombinator.com", count: 1 },
      { day: today, step: "homeViews", source: "ref:test", count: 1 },
      { day: today, step: "homeViews", source: "direct", count: 1 },
    ]));
    expect(f.sources).toHaveLength(3);
    expect(f.collectives[0].blogReads).toEqual(f.blogReads);
    expect(JSON.stringify(world.db.prepare("SELECT * FROM join_funnel_sources").all())).not.toContain("item?id");
    await app.close();
    world.close();
  });
});
