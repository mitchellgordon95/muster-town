#!/usr/bin/env node
/**
 * Delight walk (grant gr_ukrou4zjha, kr_iippfb9eax): walk a live Muster Town as a guest at 1280×720 and 390×844
 * (touch) through the first-visit moments and measure each one against the delight bar (findings dc_mgj5u0pion):
 *   land     landing page → Skip → Workshop Collective → "Watch first" → the map
 *   agent    click a working agent on the map (the HUD's "who is here" row when no name label is on screen)
 *   building enter a building: its panel (#/building/<id>)
 *   report   open the newest report (#/doc/<id>)
 *   meeting  open the newest meeting (#/meeting/<id>)
 *   oneonone a building manager's panel, where a 1:1 starts ("Talk to ★"), as a guest sees it
 * For each moment and size it saves a screenshot and prints one table row:
 *   cover%   share of the screen covered by HUD and cards (sampled every 8 px; the map canvas is "uncovered")
 *   panel%   share taken by the panel the moment opened (the thing clicked; not counted in cover%)
 *   signs    canvas texts (signs, names, bubbles) hidden under DOM (a sign behind the HUD)
 *   cut      DOM overlays cut off at the screen edge, plus horizontal page overflow
 *   ovl      pairs of overlays (HUD, minimap, panel, cards) that cover each other by more than 4 px
 *   jargon   visible text lines (DOM and canvas) with a raw id (as_…, se_…) or an internal word (hop, adj. tokens, fork …)
 *   errs     page errors and console errors
 *   reached  whether the moment's target showed (dead end otherwise), and the first plain line a stranger reads
 * No dependencies in the repo: point PLAYWRIGHT at an installed playwright-core and CHROMIUM at a browser.
 *   mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright-core@1)
 *   node scripts/delight-walk.mjs [https://muster.town/] [outDir=/tmp/delight] [--sizes=laptop,phone] [--json]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const [url = "https://muster.town/", outDir = "/tmp/delight"] = args.filter((a) => !a.startsWith("--"));
const pwPath = process.env.PLAYWRIGHT ?? "/tmp/pw/node_modules/playwright-core/index.mjs";
const { chromium } = await import(pwPath);
const origin = new URL(url).origin;
fs.mkdirSync(outDir, { recursive: true });

const SIZES = [{ n: "laptop", w: 1280, h: 720, touch: false }, { n: "phone", w: 390, h: 844, touch: true }]
  .filter((s) => !flags.sizes || String(flags.sizes).split(",").includes(s.n));

/** What a stranger shouldn't have to read: raw ids and the town's internal words. */
const ID = /\b(as|se|dc|mt|ag|bl|gr|kr|gl|sc|ms|mf|us|wk|gc)_[a-z0-9]{10}\b/;
const JARGON = /\bhops?\b|adj\.? tokens|\bforks?\b|\bsession\b|\bchain\b|\bresumeWhen\b|\{deploy|\bpark(ed)?\b|\bin-tray\b|funded by subscription|\blane\b|\bassignment\b|\bmanage session\b|\bwake\b|\bk?tokens? booked\b/i;

/** Recorded before the page loads: every canvas fillText with its box in CSS px, grouped by frame. */
const init = () => {
  const P = CanvasRenderingContext2D.prototype, ft = P.fillText;
  window.__frames = []; let cur = null, lastT = 0;
  P.fillText = function (t, x, y, ...r) {
    if (this.canvas.clientWidth > 300 && this.canvas.classList.contains("map")) {
      const m = this.getTransform(), sc = this.canvas.clientWidth / this.canvas.width;
      const now = performance.now();
      if (!cur || now - lastT > 8) { cur = []; window.__frames.push(cur); if (window.__frames.length > 60) window.__frames.shift(); }
      lastT = now;
      const r0 = this.canvas.getBoundingClientRect(), W = this.measureText(t).width * m.a * sc, fs = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 11) * m.a * sc;
      let X = (m.a * x + m.e) * sc + r0.left, Y = (m.d * y + m.f) * sc + r0.top;
      if (this.textAlign === "center") X -= W / 2; else if (this.textAlign === "right" || this.textAlign === "end") X -= W;
      if (this.textBaseline !== "top") Y -= fs * 0.8;
      cur.push({ t: String(t), X, Y, W, H: fs });
    }
    return ft.call(this, t, x, y, ...r);
  };
};

/** Measures the screen as it is now (runs in the page). */
function measure(target) {
  const vw = innerWidth, vh = innerHeight;
  const canvas = document.querySelector("canvas.map");
  const isMap = (el) => !el || el === canvas || el === document.body || el === document.documentElement || el.classList?.contains("app");
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05 && r.width > 0 && r.height > 0; };
  // cover: grid sample of what's on top
  // cover: grid sample of what's on top, apart from the panel the moment opened (that is the thing clicked)
  const own = target ? document.querySelector(target) : null;
  let total = 0, covered = 0, panel = 0;
  for (let y = 4; y < vh; y += 8) for (let x = 4; x < vw; x += 8) {
    total++;
    const el = document.elementFromPoint(x, y);
    if (own && own.contains(el)) panel++; else if (!isMap(el)) covered++;
  }
  // overlays: positioned boxes over the map, outermost only; a see-through wrapper (no background, no border) counts as its children
  const overlays = [];
  const clear = (s) => (s.backgroundColor === "rgba(0, 0, 0, 0)" || s.backgroundColor === "transparent") && s.backgroundImage === "none" && parseFloat(s.borderTopWidth) === 0;
  const add = (el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 16) return;
    if (clear(getComputedStyle(el)) && el.children.length) { for (const c of el.children) add(c); return; }
    overlays.push({ el, name: `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")}`, r });
  };
  const positioned = (el) => ["fixed", "absolute"].includes(getComputedStyle(el).position) && el !== canvas && !el.classList.contains("app");
  const positionedAbove = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (positioned(p)) return true; return false; };
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (!["fixed", "absolute"].includes(s.position) || el === canvas || el.classList.contains("app") || positionedAbove(el)) continue;
    add(el);
  }
  // does `el` show anywhere over `under` (sampled on their intersection)?
  const visibleOver = (el, under) => {
    const a = el.getBoundingClientRect(), b = under.getBoundingClientRect();
    for (let y = Math.max(a.top, b.top) + 2; y < Math.min(a.bottom, b.bottom) - 1; y += 6) for (let x = Math.max(a.left, b.left) + 2; x < Math.min(a.right, b.right) - 1; x += 6) if (el.contains(document.elementFromPoint(x, y))) return true;
    return false;
  };
  // only what shows: a hint tucked under the opened panel isn't cut off, it's covered
  const shows = (el) => { const r = el.getBoundingClientRect(); for (let y = Math.max(0, r.top) + 2; y < Math.min(vh, r.bottom) - 1; y += 6) for (let x = Math.max(0, r.left) + 2; x < Math.min(vw, r.right) - 1; x += 6) if (el.contains(document.elementFromPoint(x, y))) return true; return false; };
  const cut = overlays.filter((o) => shows(o.el)).filter((o) => o.r.left < -1 || o.r.top < -1 || o.r.right > vw + 1 || o.r.bottom > vh + 1).map((o) => o.name);
  if (document.documentElement.scrollWidth > vw + 1) cut.push(`page ${document.documentElement.scrollWidth}px wide`);
  const ovl = [];
  // the opened panel lies over the HUD by design; the HUD and cards shouldn't overlap each other or poke over the panel
  for (let i = 0; i < overlays.length; i++) for (let j = i + 1; j < overlays.length; j++) {
    if (own && (overlays[i].el === own || overlays[j].el === own) && [overlays[i], overlays[j]].some((o) => o.el !== own && !visibleOver(o.el, own))) continue;
    const a = overlays[i].r, b = overlays[j].r;
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4) ovl.push(`${overlays[i].name} × ${overlays[j].name}`);
  }
  // canvas text from the last whole frame: hidden under DOM, and its words
  const frame = window.__frames?.at(-2) ?? [];
  const onScreen = frame.filter((l) => l.X + l.W > 0 && l.X < vw && l.Y + l.H > 0 && l.Y < vh && l.t.trim());
  const hidden = onScreen.filter((l) => { const el = document.elementFromPoint(Math.min(vw - 1, Math.max(0, l.X + l.W / 2)), Math.min(vh - 1, Math.max(0, l.Y + l.H / 2))); return !isMap(el) && !(own && own.contains(el)); });
  // DOM text lines a reader can see
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.replace(/\s+/g, " ").trim();
    const el = n.parentElement;
    if (!t || !el || !vis(el) || el.closest("script,style")) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const block = el.closest("p,li,h1,h2,h3,h4,button,a,label,td,th,div,span") ?? el;
    const last = lines.at(-1);
    if (last && last.block === block) last.t += " " + t; else lines.push({ block, t, y: r.top, x: r.left });
  }
  const textLines = [...lines.map((l) => l.t), ...onScreen.map((l) => `map: ${l.t}`)];
  const sel = target ? document.querySelector(target) : null;
  const panelLines = sel ? lines.filter((l) => sel.contains(l.block)).map((l) => l.t) : [];
  return {
    cover: Math.round((100 * covered) / total),
    panel: Math.round((100 * panel) / total),
    signsHidden: hidden.map((l) => l.t),
    cut, ovl,
    lines: textLines,
    reached: target ? !!sel && vis(sel) : true,
    firstLine: panelLines.find((t) => t.length > 12 && !/^[×✕▤$?▴]$/.test(t)) ?? "",
    actions: sel ? [...sel.querySelectorAll("button,a")].filter(vis).length : 0,
  };
}

const api = async (p) => (await fetch(origin + p)).json();
const town = await api("/api/town");
const reports = (await api("/api/docs?type=report&limit=5")).docs ?? [];
const meetings = [...((await api("/api/meetings")).meetings ?? []), ...(town.meetings ?? [])];
const manager = town.agents.find((a) => a.kind === "resident" && !a.forkOf && town.buildings.some((b) => b.managerAgentId === a.id && b.id !== "town-hall"));
// `#/building/<id>` takes minted ids only (bl_…), so not the Workshop
const building = town.buildings.find((b) => /^bl_/.test(b.id));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const rows = [];
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  let errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 80)); });
  const tap = (loc) => (size.touch ? loc.tap() : loc.click());
  const settle = (ms = 1500) => page.waitForTimeout(ms);
  const hash = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await settle(2500); };
  const closePanel = async () => { await page.evaluate(() => { location.hash = ""; }); await page.keyboard.press("Escape").catch(() => {}); await settle(500); };

  const moments = [
    ["land", null, async () => {
      let clicks = 0;
      await page.goto(url, { waitUntil: "load" }); await settle(2500);
      if (await page.getByRole("button", { name: "Skip" }).isVisible().catch(() => false)) { await tap(page.getByRole("button", { name: "Skip" })); clicks++; await settle(800); }
      await tap(page.getByText("Workshop Collective").first()); clicks++; await settle(4500);
      const watch = page.getByRole("button", { name: "Watch first" });
      if (await watch.isVisible().catch(() => false)) { await tap(watch); clicks++; }
      await settle(2500);
      return `${clicks} clicks to the map`;
    }],
    ["agent", "aside.panel", async () => {
      // a working agent's name label on the canvas; click just above it (the sprite)
      // a name label is drawn as "Pix" with its number apart, so match the first word
      const names = new Set(town.agents.filter((a) => a.kind === "resident" && a.status === "working").map((a) => a.name.split(" ")[0]));
      const hit = await page.evaluate((ns) => {
        const f = window.__frames.at(-2) ?? [];
        const l = f.find((l) => ns.includes(l.t.trim()) && l.X > 0 && l.Y > 24 && l.X + l.W < innerWidth && l.Y < innerHeight - 40 && document.elementFromPoint(l.X + l.W / 2, l.Y - 14) === document.querySelector("canvas.map"));
        return l ? { x: l.X + l.W / 2, y: l.Y - 14, t: l.t } : null;
      }, [...names]);
      if (hit) { await (size.touch ? page.touchscreen.tap(hit.x, hit.y) : page.mouse.click(hit.x, hit.y)); await settle(2500); }
      if (!(await page.locator("aside.panel").isVisible().catch(() => false))) {
        const row = page.locator("button.here-row").first();
        if (await row.isVisible().catch(() => false)) { await tap(row); await settle(2500); return `${hit ? `map click on ${hit.t} opened nothing; ` : ""}via "who is here" row`; }
        return hit ? `map click on ${hit.t} opened nothing` : "no agent on screen";
      }
      return `map click on ${hit.t}`;
    }],
    ["building", "aside.panel", async () => { await closePanel(); await hash(`#/building/${building.id}`); return building.name; }],
    ["report", "aside.panel", async () => { await closePanel(); if (!reports[0]) return "no report"; await hash(`#/doc/${reports[0].id}`); return reports[0].id; }],
    ["meeting", "aside.panel", async () => { await closePanel(); if (!meetings[0]) return "no meeting"; await hash(`#/meeting/${meetings[0].id}`); return `${meetings[0].kind} ${meetings[0].phase}`; }],
    ["oneonone", "aside.panel", async () => {
      await closePanel(); if (!manager) return "no manager";
      await hash(`#/agent/${manager.id}`);
      const talk = page.locator("aside.panel").getByRole("button", { name: /Talk to/ }).first();
      const can = await talk.isVisible().catch(() => false);
      const signIn = await page.locator("aside.panel").getByText(/sign in/i).first().isVisible().catch(() => false);
      return `${manager.name}: ${can ? "Talk button shown" : "no Talk button"}${signIn ? ", asks to sign in" : ", no sign-in hint"}`;
    }],
  ];
  for (const [name, target, go] of moments) {
    errs = [];
    let note;
    try { note = await go(); } catch (e) { note = `failed: ${e.message.split("\n")[0].slice(0, 80)}`; }
    const m = await page.evaluate(measure, target).catch((e) => ({ error: e.message }));
    const shot = path.join(outDir, `${size.n}-${name}.png`);
    await page.screenshot({ path: shot });
    const jargon = (m.lines ?? []).filter((t) => ID.test(t) || JARGON.test(t));
    rows.push({ size: size.n, moment: name, note, ...m, jargonN: jargon.length, linesN: m.lines?.length ?? 0, jargon: jargon.slice(0, 6).map((t) => t.slice(0, 70)), errs: [...new Set(errs)], shot });
  }
  await ctx.close();
}
await browser.close();

if (flags.json) console.log(JSON.stringify(rows.map(({ lines, ...r }) => r), null, 2));
else {
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`delight walk on ${url}  (${new Date().toISOString()})`);
  console.log(`${pad("size", 7)}${pad("moment", 9)}${pad("cover%", 7)}${pad("panel%", 7)}${pad("signs", 6)}${pad("cut", 4)}${pad("ovl", 4)}${pad("jargon", 9)}${pad("errs", 5)}${pad("reached", 8)}first line`);
  for (const r of rows) console.log(`${pad(r.size, 7)}${pad(r.moment, 9)}${pad(r.cover, 7)}${pad(r.panel ?? "", 7)}${pad(r.signsHidden?.length ?? "?", 6)}${pad(r.cut?.length ?? "?", 4)}${pad(r.ovl?.length ?? "?", 4)}${pad(`${r.jargonN}/${r.linesN}`, 9)}${pad(r.errs.length, 5)}${pad(r.reached ? "yes" : "NO", 8)}${(r.firstLine || "").slice(0, 60)}`);
  console.log("\ndetails:");
  for (const r of rows) {
    console.log(`- ${r.size}/${r.moment}: ${r.note}${r.error ? ` (measure failed: ${r.error})` : ""}`);
    if (r.signsHidden?.length) console.log(`    hidden canvas text: ${r.signsHidden.slice(0, 6).join(" | ")}`);
    if (r.cut?.length) console.log(`    cut off: ${r.cut.join(", ")}`);
    if (r.ovl?.length) console.log(`    overlaps: ${r.ovl.slice(0, 4).join(", ")}`);
    if (r.jargon.length) console.log(`    jargon: ${r.jargon.join(" | ")}`);
    if (r.errs.length) console.log(`    errors: ${r.errs.slice(0, 3).join(" | ")}`);
  }
  console.log(`\nscreenshots in ${outDir}`);
}
