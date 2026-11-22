import { createDoc, World } from "@muster-town/core";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { BLOG_BUILDING, blogRoutes, docPosts, postOf } from "../src/blog.ts";

const ORIGIN = "https://example.town";
const post = (fm: string, body = "Hello **world**.") => `---\n${fm}\n---\n\n${body}\n`;

/** Write `files` (slug → body) as blog docs: published unless the body says `draft: true`, which writes a draft. */
function seed(world: World, files: Record<string, string>, o: { buildingId?: string; tags?: string[]; type?: "article" | "note" } = {}) {
  for (const [slug, text] of Object.entries(files)) {
    const draft = /\ndraft: true\n/.test(text);
    const body = text.replace(/\ndraft: true\n/, "\n").replace(/^---\n/, `---\nslug: ${slug}\n`);
    createDoc(world, { type: o.type ?? "article", title: /title: "?([^"\n]*)/.exec(text)?.[1] ?? slug, body, authorId: "ag_writer", authorKind: "agent",
      state: draft ? "draft" : "building", buildingId: o.buildingId ?? BLOG_BUILDING, tags: o.tags ?? ["blog"] });
  }
}

async function blogApp(files: Record<string, string>, onRead?: (slug: string, source: string) => void) {
  const world = World.open(":memory:");
  seed(world, files);
  const app = Fastify();
  await app.register(blogRoutes(ORIGIN, docPosts(world), onRead));
  return app;
}

describe("blog", () => {
  it("says there are no posts when there are none", async () => {
    const app = await blogApp({});
    const res = await app.inject("/blog");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("No posts yet.");
  });

  it("lists public posts newest first and renders a post with its preview tags", async () => {
    const app = await blogApp({
      "older": post("title: Older post\ndate: 2026-11-01\nauthor: Mitchell\nsummary: The first one."),
      "newer": post('title: "Newer <post>"\ndate: 2026-11-10\nsummary: The second one.'),
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
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og.png">`); // no cover: the site's picture (gr_y8buqgpata)
    expect(html).toContain(`<meta name="twitter:image" content="${ORIGIN}/og.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<link rel="alternate" type="application/atom+xml" title="Muster Town blog" href="${ORIGIN}/blog/feed.xml">`);
    expect(html).toContain("Hello <strong>world</strong>.");
    expect(html).toContain(`<form class="signup"`);
  });

  it("puts the email signup at the foot of each post and of the index, tagged with where it was", async () => {
    const app = await blogApp({ "older": post("title: Older post\ndate: 2026-11-01") });
    const html = (await app.inject("/blog/older")).body;
    expect(html).toContain('<form class="signup" method="post" action="/api/blog/subscribe" data-source="older">');
    expect(html).toContain("New posts by email. Nothing else.");
    expect(html.indexOf('class="signup"')).toBeGreaterThan(html.indexOf("</article>"));
    expect((await app.inject("/blog")).body).toContain('data-source="index"');
  });

  it("ends each post with an About Muster Town box above the signup: the homepage's line, the live town and the repo (gr_y8buqgpata)", async () => {
    const app = await blogApp({ "older": post("title: Older post\ndate: 2026-11-01") });
    const html = (await app.inject("/blog/older")).body;
    expect(html).toContain('<section class="about">');
    expect(html).toContain("<p>Muster Town is AI agents working in public, collectively funded. Humans watch, fund and steer.</p>");
    expect(html).toContain('<a href="/workshop/">Visit the live town</a>');
    expect(html).toContain('<a href="https://github.com/mitchellgordon95/muster-town">Muster Town on GitHub</a>');
    expect(html.indexOf('class="about"')).toBeGreaterThan(html.indexOf("</article>"));
    expect(html.indexOf('class="about"')).toBeLessThan(html.indexOf('class="signup"'));
    expect((await app.inject("/blog")).body).not.toContain('class="about"');
  });

  it("shows a post's upcoming list as the signup hook, on the post and on the index", async () => {
    const app = await blogApp({
      "older": post("title: Older\ndate: 2026-11-01"),
      "next": post("title: Next\ndate: 2026-11-19\nupcoming:\n  - the operating layers (jobs + queues)\n  - using <Bend> 2\nauthor: Mitchell"),
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

  it("never serves a draft doc: not at its URL, not in the index or the feed", async () => {
    const app = await blogApp({
      "live": post("title: Live\ndate: 2026-11-02"),
      "secret": post("title: Secret draft\ndate: 2026-11-11\ndraft: true"),
    });
    expect((await app.inject("/blog/secret")).statusCode).toBe(404);
    expect((await app.inject("/blog")).body).not.toContain("secret");
    const feed = (await app.inject("/blog/feed.xml")).body;
    expect(feed).toContain(`${ORIGIN}/blog/live`);
    expect(feed).not.toContain("secret");
  });

  it("answers an unknown or malformed slug with a 404 page", async () => {
    const app = await blogApp({ "live": post("title: Live\ndate: 2026-11-02") });
    for (const url of ["/blog/nope", "/blog/..%2Fsecret", "/blog/UPPER"]) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("Post not found");
    }
  });

  it("shows a cover image from image: at the top, in the link preview and as the feed's enclosure", async () => {
    const app = await blogApp({
      "pic": post("title: Pic\ndate: 2026-11-04\nimage: /api/media/mf_abcdefghij.png", "Body ![chart](/api/media/mf_0123456789.jpg)"),
      "bad": post("title: Bad\ndate: 2026-11-03\nimage: javascript:alert(1)"),
    });
    const html = (await app.inject("/blog/pic")).body;
    expect(html).toContain('<img class="cover" src="/api/media/mf_abcdefghij.png" alt="">');
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/api/media/mf_abcdefghij.png">`);
    expect(html).toContain(`<meta name="twitter:image" content="${ORIGIN}/api/media/mf_abcdefghij.png">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<img src="/api/media/mf_0123456789.jpg" alt="chart">');
    const bad = (await app.inject("/blog/bad")).body;
    expect(bad).toContain(`<meta property="og:image" content="${ORIGIN}/og.png">`);
    expect(bad).not.toContain("javascript:");
    const feed = (await app.inject("/blog/feed.xml")).body;
    expect(feed).toContain(`<link rel="enclosure" href="${ORIGIN}/api/media/mf_abcdefghij.png" type="image/png"/>`);
    expect(feed.match(/enclosure/g)).toHaveLength(1);
  });

  it("serves a well-formed Atom feed", async () => {
    const app = await blogApp({ "a": post("title: A & B\ndate: 2026-11-03\nauthor: Juno\nsummary: <x>") });
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
    seed(world, { "hello-from-muster-town": post("title: Hello from Muster Town\ndate: 2026-11-12") });
    const app = await buildApp({ world, webDist: dist });
    expect((await app.inject("/blog")).statusCode).toBe(200);
    expect((await app.inject("/blog/feed.xml")).body).toContain("/blog/hello-from-muster-town");
    expect((await app.inject("/sitemap.xml")).body).toContain(`/blog/hello-from-muster-town</loc>`);
    expect((await app.inject("/blog/hello-from-muster-town")).body).toContain("Hello from Muster Town");
    expect((await app.inject("/blog/no-such-post")).statusCode).toBe(404);
    expect((await app.inject("/elsewhere")).statusCode).toBe(302);
    await app.close();
    world.close();
  });

  it("counts each browser read of a public post with its source (gr_ox3fmliv9n); bots, HEAD, drafts and missing posts never count", async () => {
    const reads: [string, string][] = [];
    const app = await blogApp({ "live": post("title: Live\ndate: 2026-11-10"), "wip": post("title: Wip\ndate: 2026-11-10\ndraft: true") }, (slug, source) => reads.push([slug, source]));
    const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36";
    await app.inject({ url: "/blog/live", headers: { "user-agent": ua, referer: "https://news.ycombinator.com/item?id=42" } });
    await app.inject({ url: "/blog/live?ref=Discord", headers: { "user-agent": ua, referer: "https://news.ycombinator.com/" } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": ua, referer: `${ORIGIN}/blog` } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
    await app.inject({ url: "/blog/live", headers: { "user-agent": "curl/8.5.0" } });
    await app.inject({ method: "HEAD", url: "/blog/live", headers: { "user-agent": ua } });
    await app.inject({ url: "/blog/wip", headers: { "user-agent": ua } });
    await app.inject({ url: "/blog/nope", headers: { "user-agent": ua } });
    expect(reads).toEqual([["live", "news.ycombinator.com"], ["live", "ref:discord"], ["live", "blog"]]);
  });

  it("the root app's blog reads and homepage sources show on GET /api/join-funnel", async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    const world = World.open(":memory:");
    seed(world, { "hello-from-muster-town": post("title: Hello\ndate: 2026-11-12\ndraft: true"), "engineering-human-oversight-with-decision-queues": post("title: Oversight\ndate: 2026-11-19") });
    const app = await buildApp({ world, webDist: dist });
    const ua = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36" };
    await app.inject({ url: "/blog/hello-from-muster-town", headers: ua }); // a draft: never counted
    await app.inject({ url: "/blog/engineering-human-oversight-with-decision-queues", headers: { ...ua, referer: "https://news.ycombinator.com/" } });
    const home = (body: object) => app.inject({ method: "POST", url: "/api/join-funnel/home", headers: { ...ua, host: "muster.town" }, payload: body });
    expect((await home({ visitor: "visitor-from-hn-1", referrer: "https://news.ycombinator.com/item?id=1" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-tagged-01", ref: "test", referrer: "https://muster.town/blog" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-internal1", referrer: "https://muster.town/blog/engineering-human-oversight-with-decision-queues" })).json()).toEqual({ counted: true }); // the About box's link (gr_y8buqgpata)
    expect((await home({ visitor: "visitor-internal2", referrer: "https://muster.town/workshop/" })).json()).toEqual({ counted: true });
    expect((await home({ visitor: "visitor-from-hn-1", step: "page2" })).json()).toEqual({ counted: true }); // a step carries no source
    const f = (await app.inject("/api/join-funnel")).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(f.blogReads).toEqual([{ day: today, slug: "engineering-human-oversight-with-decision-queues", source: "news.ycombinator.com", count: 1 }]);
    expect(f.sources).toEqual(expect.arrayContaining([
      { day: today, step: "homeViews", source: "news.ycombinator.com", count: 1 },
      { day: today, step: "homeViews", source: "ref:test", count: 1 },
      { day: today, step: "homeViews", source: "blog", count: 1 },
      { day: today, step: "homeViews", source: "direct", count: 1 },
    ]));
    expect(f.sources).toHaveLength(4);
    expect(f.collectives[0].blogReads).toEqual(f.blogReads);
    expect(JSON.stringify(world.db.prepare("SELECT * FROM join_funnel_sources").all())).not.toContain("item?id");
    await app.close();
    world.close();
  });

  it("reads only published blog articles in the blog's building", async () => {
    const world = World.open(":memory:");
    seed(world, { "ok": post("title: Ok\ndate: 2026-11-01") });
    seed(world, { "elsewhere": post("title: Elsewhere\ndate: 2026-11-01") }, { buildingId: "bl_other" });
    seed(world, { "untagged": post("title: Untagged\ndate: 2026-11-01") }, { tags: ["blogger"] });
    seed(world, { "a-note": post("title: A note\ndate: 2026-11-01") }, { type: "note" });
    seed(world, { "ok": post("title: Second with the same slug\ndate: 2026-11-05") });
    expect(docPosts(world)().map((p) => [p.slug, p.title])).toEqual([["ok", "Ok"]]);
  });

  it("takes the slug from the title and the date from the doc when the front matter leaves them out", () => {
    expect(postOf({ title: "Why We Built It!", body: "Plain **markdown**.", createdAt: "2026-11-20T02:00:00.000Z" }))
      .toEqual({ slug: "why-we-built-it", title: "Why We Built It!", date: "2026-11-20", author: "", summary: "", upcoming: [], body: "Plain **markdown**.", image: "" });
    expect(postOf({ title: "x", body: post("slug: Bad Slug"), createdAt: "2026-11-20T02:00:00.000Z" })).toBeNull();
  });

  it("shows raw HTML as text and drops script links: posts are town docs, not trusted files", async () => {
    const app = await blogApp({ "x": post("title: X\ndate: 2026-11-01", '<script>alert(1)</script>\n\n[ok](https://a.example/) [bad](javascript:alert(1)) ![i](/og.png)') });
    const html = (await app.inject("/blog/x")).body;
    const article = html.slice(html.indexOf("<article>"), html.indexOf("</article>"));
    expect(article).not.toContain("<script>");
    expect(article).toContain("&lt;script&gt;");
    expect(article).toContain('<a href="https://a.example/">ok</a>');
    expect(article).not.toContain("javascript:");
    expect(article).toContain('<img src="/og.png" alt="i">');
  });
});
