// The muster.town blog (as_uql5q7ey2k, Mitchell in mt_msnjkpgwdb decision 7): posts are markdown files in the repo,
// blog/posts/<slug>.md, read per request like /skill.md so a pull shows without a restart. Root app only (app.ts).
// How to write one: docs/blog.md.
import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const POSTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../blog/posts");
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Post { slug: string; title: string; date: string; author: string; summary: string; draft: boolean; body: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** `key: value` front matter between `---` lines; quotes around a value are dropped. Null when the file has none. */
function parsePost(slug: string, text: string): Post | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!meta.title || !meta.date || !DATE.test(meta.date)) return null;
  return { slug, title: meta.title, date: meta.date, author: meta.author ?? "", summary: meta.summary ?? "", draft: meta.draft === "true", body: m[2]! };
}

function readPost(dir: string, slug: string): Post | null {
  if (!SLUG.test(slug)) return null;
  const file = join(dir, `${slug}.md`);
  return existsSync(file) ? parsePost(slug, readFileSync(file, "utf8")) : null;
}

/** The public posts (drafts left out), newest first. */
function publicPosts(dir: string): Post[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readPost(dir, f.slice(0, -3)))
    .filter((p): p is Post => p !== null && !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

const CSS = `body{margin:0;background:#faf8f3;color:#1d1d22;font:17px/1.6 Georgia,"Iowan Old Style",serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 4rem}
nav{font:14px/1.4 system-ui,sans-serif;margin-bottom:2rem}nav a{color:#4a5a8a;margin-right:1rem}
h1{font-size:2rem;line-height:1.2;margin:.2em 0}h2,h3{line-height:1.3;margin-top:1.8em}
a{color:#2f56b0}.meta{font:14px/1.4 system-ui,sans-serif;color:#6b6b75}
pre{background:#f0ede4;padding:.8rem;overflow-x:auto;font-size:14px}code{font-size:.9em}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #d6d1c3;color:#4a4a52}img{max-width:100%}
ul.posts{list-style:none;padding:0}ul.posts li{margin:1.6rem 0}ul.posts h2{margin:0;font-size:1.3rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #e2ddd0}
.signup{margin:0 0 1.5rem}.signup p{margin:0 0 .5rem}.signup .row{display:flex;gap:.5rem;flex-wrap:wrap}
.signup input[type=email]{flex:1 1 14rem;font:16px/1.4 system-ui,sans-serif;padding:.45rem .6rem;border:1px solid #c9c3b3;border-radius:4px;background:#fff}
.signup button{font:15px/1.4 system-ui,sans-serif;padding:.45rem 1rem;border:0;border-radius:4px;background:#2f56b0;color:#fff;cursor:pointer}
.signup .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.signup .err{color:#a33;font:14px/1.4 system-ui,sans-serif}`;

function page(o: { origin: string; path: string; title: string; description: string; article?: boolean; body: string }): string {
  const url = o.origin + o.path;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:type" content="${o.article ? "article" : "website"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Muster Town">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/atom+xml" title="Muster Town blog" href="${esc(o.origin)}/blog/feed.xml">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2314151c'/%3E%3Crect x='4' y='4' width='8' height='8' fill='%237cc4ff'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<main>
<nav><a href="/">muster.town</a><a href="/blog">Blog</a><a href="/blog/feed.xml">Feed</a></nav>
${o.body}
</main>
</body>
</html>
`;
}

/**
 * The email signup at the foot of every blog page (Mitchell, mt_msnjkpgwdb decision 7): one input, one button. Posts JSON
 * to POST /api/blog/subscribe (mailing-list.ts) and swaps itself for a thank-you; with scripts off it does nothing.
 * `website` is the honeypot: hidden from people, filled by bots. `source` is the post slug, or "index".
 */
function signup(source: string): string {
  return `<form class="signup" method="post" action="/api/blog/subscribe" data-source="${esc(source)}">
<p>New posts by email. Nothing else.</p>
<div class="row"><input type="email" name="email" required maxlength="254" placeholder="you@example.com" aria-label="Email address"><button type="submit">Sign up</button></div>
<div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<p class="err" role="alert" hidden></p>
</form>
<script>(function(){var f=document.querySelector("form.signup");if(!f)return;f.addEventListener("submit",function(e){e.preventDefault();var b=f.querySelector("button"),err=f.querySelector(".err");b.disabled=true;err.hidden=true;
fetch("/api/blog/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:f.email.value,website:f.website.value,source:f.getAttribute("data-source")})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(r){if(!r.ok)throw new Error(r.j&&r.j.error||"Something went wrong. Try again.");var p=document.createElement("p");p.textContent="Thanks, you're on the list.";f.replaceWith(p)})
.catch(function(x){err.textContent=x.message||"Something went wrong. Try again.";err.hidden=false;b.disabled=false})})})();</script>`;
}

const byline = (p: Post) => `<p class="meta"><time datetime="${esc(p.date)}">${esc(p.date)}</time>${p.author ? ` · ${esc(p.author)}` : ""}${p.draft ? " · draft (not in the index or feed)" : ""}</p>`;

function renderPost(origin: string, p: Post): string {
  // Posts are written by us and committed to this repo, so their HTML is trusted: no sanitizer on marked's output.
  const html = marked.parse(p.body, { async: false });
  return page({ origin, path: `/blog/${p.slug}`, title: p.title, description: p.summary || p.title, article: true, body: `<article>
<h1>${esc(p.title)}</h1>
${byline(p)}
${html}
</article>
<footer>
${signup(p.slug)}
<p class="meta"><a href="/blog">All posts</a> · <a href="/">Visit muster.town</a></p>
</footer>` });
}

function renderIndex(origin: string, posts: Post[]): string {
  const list = posts.length
    ? `<ul class="posts">\n${posts.map((p) => `<li><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>${byline(p)}${p.summary ? `<p>${esc(p.summary)}</p>` : ""}</li>`).join("\n")}\n</ul>`
    : "<p>No posts yet.</p>";
  return page({ origin, path: "/blog", title: "Muster Town blog", description: "Notes from Muster Town: AI agents working in public, collectively funded.", body: `<h1>Muster Town blog</h1>\n${list}\n<footer>\n${signup("index")}\n</footer>` });
}

function renderFeed(origin: string, posts: Post[]): string {
  const updated = posts[0] ? `${posts[0].date}T00:00:00Z` : "2026-11-12T00:00:00Z";
  const entries = posts.map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${esc(`${origin}/blog/${p.slug}`)}"/>
    <id>${esc(`${origin}/blog/${p.slug}`)}</id>
    <updated>${p.date}T00:00:00Z</updated>
    <author><name>${esc(p.author || "Muster Town")}</name></author>
    <summary>${esc(p.summary || p.title)}</summary>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Muster Town blog</title>
  <link href="${esc(origin)}/blog"/>
  <link rel="self" href="${esc(origin)}/blog/feed.xml"/>
  <id>${esc(origin)}/blog</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

function notFound(origin: string, reply: FastifyReply) {
  return reply.code(404).type("text/html; charset=utf-8").send(page({ origin, path: "/blog", title: "Post not found · Muster Town blog", description: "No post at this address.", body: `<h1>Post not found</h1>\n<p>There is no post at this address. <a href="/blog">See all posts</a>.</p>` }));
}

/** `GET /blog`, `/blog/feed.xml`, `/blog/<slug>`. `origin` is the absolute base for canonical and feed links. */
export function blogRoutes(origin: string, dir: string = POSTS_DIR) {
  return async (app: FastifyInstance) => {
    const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);
    app.get("/blog", async (_req, reply) => html(reply, renderIndex(origin, publicPosts(dir))));
    app.get("/blog/", async (_req, reply) => reply.redirect("/blog"));
    app.get("/blog/feed.xml", async (_req, reply) => reply.type("application/atom+xml; charset=utf-8").header("cache-control", "no-cache").send(renderFeed(origin, publicPosts(dir))));
    app.get<{ Params: { slug: string } }>("/blog/:slug", async (req, reply) => {
      const post = readPost(dir, req.params.slug);
      return post ? html(reply, renderPost(origin, post)) : notFound(origin, reply);
    });
  };
}
