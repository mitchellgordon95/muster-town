import { createDoc, World } from "@muster-town/core";
import Fastify from "fastify";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { excerpt, previewTags, robotsTxt, siteJsonLd, sitemapXml, sitePages, siteRoutes, verificationTags, withPreview } from "../src/share.ts";

const ORIGIN = "https://muster.town";
const tagsOf = (html: string) => ({
  title: /<meta property="og:title" content="([^"]*)">/.exec(html)?.[1],
  description: /<meta property="og:description" content="([^"]*)">/.exec(html)?.[1],
  image: /<meta property="og:image" content="([^"]*)">/.exec(html)?.[1],
  url: /<meta property="og:url" content="([^"]*)">/.exec(html)?.[1],
  card: /<meta name="twitter:card" content="([^"]*)">/.exec(html)?.[1],
});

describe("share previews and site files (pure)", () => {
  it("previewTags escapes what it is given: no input closes a tag or an attribute", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (title, description) => {
      const html = previewTags({ title, description, url: `${ORIGIN}/`, image: `${ORIGIN}/og.png` });
      // every line is one whole tag: an input's < > " never leaks into the markup
      for (const line of html.split("\n")) expect(line).toMatch(/^<(title>[^<>]*<\/title|meta [a-z]+="[^"<>]*" content="[^"<>]*")>$/);
    }));
  });

  it("withPreview replaces the client's title, else goes first in head", () => {
    const p = { title: "T", description: "D", url: `${ORIGIN}/workshop/`, image: `${ORIGIN}/og.png` };
    const a = withPreview("<!doctype html><head><title>Muster Town</title></head>", p, "x()");
    expect(a).not.toContain("<title>Muster Town</title>");
    expect(a).toContain("<title>T</title>");
    expect(a).toContain("<script>x()</script>");
    expect(withPreview("<html><head></head></html>", p)).toMatch(/^<html><head>\n<title>T<\/title>/);
    // a $ in the title is text, not a replacement pattern
    expect(withPreview("<title>x</title>", { ...p, title: "$& $1" })).toContain("<title>$&amp; $1</title>");
  });

  it("excerpt flattens markdown and cuts at a word", () => {
    expect(excerpt("# Head\n\nSome **bold** [link](https://x.y) text.")).toBe("Head Some bold link text.");
    const long = excerpt("word ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith("word…")).toBe(true);
  });

  it("robots.txt allows everything and names the sitemap; the sitemap lists /, the client, /blog and each post", () => {
    expect(robotsTxt(ORIGIN)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    const xml = sitemapXml(ORIGIN, sitePages({ clientPaths: ["/workshop/"], posts: [{ slug: "hello", date: "2026-11-20" }] }));
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const loc of ["/", "/workshop/", "/blog", "/blog/hello"]) expect(xml).toContain(`<loc>${ORIGIN}${loc}</loc>`);
    expect(xml).toContain("<lastmod>2026-11-20</lastmod>");
    expect(xml).not.toContain("/hooks");
  });

  it("sitePages lists every public page once: collectives, posts (updatedAt over date), /hooks and each cause page", () => {
    const pages = sitePages({
      clientPaths: ["/workshop/", "/acme/", "/workshop/"],
      posts: [{ slug: "a", date: "2026-11-20", updated: "2026-11-21T10:00:00.000Z" }],
      hooks: { updated: "2026-11-23T16:00:00.000Z" },
      hookPages: [{ slug: "cptsd", updated: "2026-11-23T17:00:00.000Z" }, { slug: "climate-adaptation" }],
    });
    expect(pages.map((p) => p.path)).toEqual(["/", "/workshop/", "/acme/", "/blog", "/blog/a", "/hooks", "/hooks/cptsd", "/hooks/climate-adaptation"]);
    expect(pages.find((p) => p.path === "/blog/a")?.lastmod).toBe("2026-11-21T10:00:00.000Z");
    // property: never a duplicate path, and every post and cause page is there
    fc.assert(fc.property(fc.array(fc.constantFrom("/workshop/", "/a/", "/b/")), fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/)), (clients, slugs) => {
      const ps = sitePages({ clientPaths: clients, posts: slugs.map((slug) => ({ slug, date: "2026-11-20" })), hooks: {}, hookPages: slugs.map((slug) => ({ slug })) });
      const paths = ps.map((p) => p.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const s of slugs) { expect(paths).toContain(`/blog/${s}`); expect(paths).toContain(`/hooks/${s}`); }
    }));
  });

  it("the JSON-LD names Muster Town with the repo as sameAs and cannot be closed by its content", () => {
    const tag = siteJsonLd(ORIGIN);
    const json = JSON.parse(/^<script type="application\/ld\+json">([\s\S]*)<\/script>$/.exec(tag)![1]!);
    const org = json["@graph"].find((x: { "@type": string }) => x["@type"] === "Organization");
    expect(org).toMatchObject({ name: "Muster Town", alternateName: "muster.town", url: `${ORIGIN}/`, logo: `${ORIGIN}/og.png`, sameAs: ["https://github.com/mitchellgordon95/muster-town"] });
    expect(json["@graph"].some((x: { "@type": string }) => x["@type"] === "WebSite")).toBe(true);
    expect(siteJsonLd("https://x.y/</script>")).not.toContain("</script><");
  });

  it("verificationTags shows only the tokens set, escaped", () => {
    expect(verificationTags(undefined)).toBe("");
    expect(verificationTags({ google: "abc" })).toBe('<meta name="google-site-verification" content="abc">');
    expect(verificationTags({ bing: 'x"y' })).toBe('<meta name="msvalidate.01" content="x&quot;y">');
  });
});

describe("site routes", () => {
  it("serves /og.png, /robots.txt and /sitemap.xml with each public post", async () => {
    const dir = mkdtempSync(join(tmpdir(), "og-"));
    writeFileSync(join(dir, "og.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = Fastify();
    await app.register(siteRoutes({ origin: ORIGIN, pages: () => sitePages({ clientPaths: ["/workshop/"], posts: [{ slug: "first", date: "2026-11-21" }] }), image: join(dir, "og.png"), indexNowKey: "0123456789abcdef" }));
    const key = await app.inject("/0123456789abcdef.txt");
    expect(key.statusCode).toBe(200);
    expect(key.body).toBe("0123456789abcdef");
    const png = await app.inject("/og.png");
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    const robots = await app.inject("/robots.txt");
    expect(robots.statusCode).toBe(200);
    expect(robots.headers["content-type"]).toMatch(/^text\/plain/);
    expect(robots.body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const map = await app.inject("/sitemap.xml");
    expect(map.statusCode).toBe(200);
    expect(map.headers["content-type"]).toMatch(/^application\/xml/);
    expect(map.body).toContain(`<loc>${ORIGIN}/blog/first</loc>`);
  });

  it("the shipped town picture is served by the real app", async () => {
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: false });
    const png = await app.inject("/og.png");
    expect(png.statusCode).toBe(200);
    expect(png.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    expect((await app.inject("/robots.txt")).statusCode).toBe(200);
    expect((await app.inject("/sitemap.xml")).body).toContain(`<loc>${ORIGIN}/blog</loc>`);
    await app.close(); world.close();
  });
});

describe("preview tags on /, the client and shared doc and grant links", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let world: World;
  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Muster Town</title></head><body><div id="root"></div></body></html>');
    world = World.open(":memory:");
    app = await buildApp({ world, webDist: dist });
  });
  afterAll(async () => { await app.close(); world.close(); });
  const get = (url: string) => app.inject({ method: "GET", url });
  const town = () => world.town.get().name;
  const townTitle = () => town() === "Muster Town" ? "Muster Town" : `${town()} · Muster Town`;

  it("/ has og:title, og:description, og:image and a large-image twitter card", async () => {
    const t = tagsOf((await get("/")).body);
    expect(t.title).toBe("Muster Town: AI agents working in public");
    expect(t.description).toMatch(/^Muster Town is AI agents working in public/);
    expect(t.image).toBe(`${ORIGIN}/og.png`);
    expect(t.url).toBe(`${ORIGIN}/`);
    expect(t.card).toBe("summary_large_image");
  });

  it("/workshop/ is the client with the town's tags", async () => {
    const r = await get("/workshop/");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.body).toContain('<div id="root"></div>');
    const t = tagsOf(r.body);
    expect(t.title).toBe(townTitle());
    expect(t.image).toBe(`${ORIGIN}/og.png`);
  });

  it("a shared doc link previews that doc and becomes its hash URL; a draft or unknown doc previews the town", async () => {
    const author = { authorId: "us_tester", authorKind: "user" as const };
    const pub = createDoc(world, { title: "How the Bank works", body: "## Money\n\nEvery token is **public**.", type: "article", state: "library", ...author });
    const r = await get(`/workshop/doc/${pub.id}`);
    expect(r.statusCode).toBe(200);
    const t = tagsOf(r.body);
    expect(t.title).toBe(`How the Bank works · ${town()}`);
    expect(t.description).toBe("Money Every token is public.");
    expect(t.url).toBe(`${ORIGIN}/workshop/doc/${pub.id}`);
    expect(t.image).toBe(`${ORIGIN}/og.png`);
    expect(r.body).toContain(`history.replaceState(null, "", "/workshop/#/doc/${pub.id}")`);
    expect(r.body).toContain('<div id="root"></div>');

    const draft = createDoc(world, { title: "Secret plan", body: "nope", type: "note", state: "draft", ...author });
    const d = (await get(`/workshop/doc/${draft.id}`)).body;
    expect(d).not.toContain("Secret plan");
    expect(tagsOf(d).title).toBe(townTitle());
    expect(tagsOf((await get("/workshop/doc/dc_nosuchdoc")).body).title).toBe(townTitle());
  });

  it("a shared grant link previews the grant and becomes its hash URL", async () => {
    const r = await get("/workshop/grant/gr_nosuchgrnt");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('history.replaceState(null, "", "/workshop/#/grant/gr_nosuchgrnt")');
    expect(tagsOf(r.body).title).toBe(townTitle());
  });
});
