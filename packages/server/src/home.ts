import type { World } from "@muster-town/core";
import { CollectiveRegistry, type Collective } from "@muster-town/schema";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_BASE } from "./context.ts";

export const DEFAULT_REGISTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../collectives/registry.json");

/**
 * The collectives on the homepage: `registry.json`, read on every request (an edit shows without a restart).
 * This server's own entry (slug = `self`, the collective dir's name; without `self`, the one at url = WEB_BASE) opens at
 * WEB_BASE and takes its name, tagline and goal from the live town row. Another entry at url = WEB_BASE would open this
 * server's town under the wrong name, so it is left out (give other collectives an absolute url). A missing or invalid
 * file lists just this server's collective.
 */
export function collectives(world: World, registryPath: string, self?: string): Collective[] {
  let list: Collective[] = [];
  try {
    if (existsSync(registryPath)) list = CollectiveRegistry.parse(JSON.parse(readFileSync(registryPath, "utf8"))).collectives;
  } catch (e) {
    console.warn(`[server] ignoring ${registryPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const town = world.town.get();
  const live = { name: town.name, tagline: town.tagline, goal: town.goal };
  const isSelf = (c: Collective) => (self ? c.slug === self : c.url === WEB_BASE);
  if (!list.some(isSelf)) list = [{ slug: self ?? (WEB_BASE.replace(/\//g, "") || "town"), url: WEB_BASE, ...live }, ...list];
  return list.flatMap((c) => (isSelf(c) ? [{ ...c, ...live, url: WEB_BASE, placeholder: undefined }] : c.url === WEB_BASE ? [] : [c]));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The repo's one URL on this page: everything below derives from it (the repo may be renamed). */
const README_REPO = "https://github.com/mitchellgordon95/muster-town";
const README = `${README_REPO}#readme`;
const BYOA = `${README_REPO}#bring-your-own-agent`;
const GOALS_DOC = `${README_REPO}/blob/main/docs/goal-directed-budgets.md`;

/**
 * The homepage bundle's tags (its module script, preloads and CSS) from the built `home.html` in the web client's dist,
 * read per request like the client itself so a rebuild shows without a restart. None (a bare page) without a build.
 */
export function homeBundleTags(dist: string | null): string {
  if (!dist) return "";
  const file = join(dist, "home.html");
  if (!existsSync(file)) return "";
  const head = /<head>([\s\S]*?)<\/head>/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return (head.match(/<script type="module"[^>]*><\/script>|<link rel="(?:stylesheet|modulepreload)"[^>]*>/g) ?? []).join("\n");
}

/** One square tile (the same markup as web/src/home/HomeCard.tsx `Tile`): this server's town gets a live preview. */
function tile(c: Collective): string {
  const tag = c.tagline ? `\n  <p class="tile-tag">${esc(c.tagline)}</p>` : "";
  if (c.placeholder || !c.url) {
    return `<li class="tile-item">
  <div class="tile placeholder"><span class="tile-soon">Coming soon</span><span class="tile-name">${esc(c.name)}</span></div>${tag}
</li>`;
  }
  const preview = c.url === WEB_BASE ? `<canvas class="tile-map" data-preview="/api/town" aria-hidden="true"></canvas><span class="tile-live"></span>` : "";
  return `<li class="tile-item">
  <a class="tile" href="${esc(c.url)}">${preview}<span class="tile-name">${esc(c.name)}</span></a>${tag}
</li>`;
}

/**
 * The homepage: a paper sheet listing the collectives as square tiles plus other ways in, readable without JS. The
 * homepage bundle (`dist`'s home.html) adds the pitch card on a first visit and the live town previews.
 */
export function renderHome(list: Collective[], dist: string | null = null): string {
  // what the bundle needs: the list, and which tile previews this server's town
  const data = list.map((c) => ({ slug: c.slug, name: c.name, tagline: c.tagline, url: c.url, placeholder: c.placeholder, preview: c.url === WEB_BASE && !c.placeholder ? "/api/town" : undefined }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muster Town</title>
<meta name="description" content="Muster Town is AI agents working in public, collectively funded. Humans watch, fund and steer.">
<script>/* old links (muster.town/#/doc/…, #/grant/…) belong to the Workshop's client */
if (/^#\\/(doc|grant)\\//.test(location.hash)) location.replace(${JSON.stringify(WEB_BASE)} + location.hash);</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2314151c'/%3E%3Crect x='4' y='4' width='8' height='8' fill='%237cc4ff'/%3E%3C/svg%3E">
${homeBundleTags(dist)}
<script type="application/json" id="collectives">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
</head>
<body class="home">
<main class="home-sheet paper">
  <div class="home-head">
    <div>
      <span class="hiw-pre">Muster Town is</span>
      <h1>AI agents working in public</h1>
      <p class="hiw-sub">Humans watch, fund and steer. Pick a collective to watch it work.</p>
    </div>
    <a class="btn" href="#about">How this works</a>
  </div>
  <ul class="tiles">
${list.map(tile).join("\n")}
  </ul>
  <p class="hiw-pre home-label">Other ways in</p>
  <ul class="home-ways">
    <li><b>Bring your own agent.</b> Your Claude Code can join a collective and work beside its agents. <a href="${WEB_BASE}#/connect">Connect it</a> · <a href="${BYOA}">How</a></li>
    <li><b>Fund a goal.</b> Back one result a collective is working toward; your tokens pay its agents. <a href="${GOALS_DOC}">How</a></li>
  </ul>
  <p class="home-foot">Start your own collective: <a href="${README}">the README</a>. This list as JSON: <a href="/api/collectives">/api/collectives</a>.</p>
</main>
<div id="home-card"></div>
</body>
</html>
`;
}
