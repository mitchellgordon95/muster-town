#!/usr/bin/env node
/**
 * Type and contrast census (grant gr_kvmwutmybu, skill dc_wzyyl44zwi): opens the 10 guest views (home page, the
 * how-it-works card, map, building, report, meeting, agent, grant, manual, Bank) at 1280x800 and 390x844 and, for every
 * visible DOM text, records font size, colour and WCAG contrast against its composited background (ancestor opacity
 * included; disabled controls exempt). Prints one row per view: sizes, lowLines (distinct text rows under 4.5:1, 3:1
 * large), samples. Needs playwright-core in /tmp/pw and /usr/bin/chromium.
 *   node scripts/type-contrast-census.mjs laptop,phone      ORIGIN=http://localhost:5200 for a vite dev server
 *   (HOME_URL=http://localhost:5200/workshop/home.html for the home card on dev; VIEWS=agent,bank to pick views)
 * Mock mode (kr_mmdday2x7z, the signed-in views): every panel kind and every tab of it on the mock fixture, signed in as
 * the mock admin, opened through the dev-only `window.__muster.open` (the panel list of scripts/disclosure-census.mjs,
 * plus the review deck). One row per panel/tab, measured on the whole screen like the guest views.
 *   (cd packages/web && VITE_MOCK=1 npx vite --port 5199 &)
 *   MOCK=http://localhost:5199/workshop/ node scripts/type-contrast-census.mjs laptop,phone      (ONLY=grant,bank to pick kinds)
 */
import fs from "node:fs";
const { chromium } = await import("/tmp/pw/node_modules/playwright-core/index.mjs");
const origin = (process.env.ORIGIN ?? "https://muster.town").replace(/\/$/, "");
const HOME = process.env.HOME_ORIGIN ?? origin; // the home page "/" is rendered by the server
const base = origin + "/workshop/";
const OUT = process.env.OUT ?? "/tmp/vis";
fs.mkdirSync(OUT, { recursive: true });
const get = async (p) => { for (const u of [base.replace(/\/$/, "") + p, origin + p]) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} } return {}; };
const town = await get("/api/town");
const reports = (await get("/api/docs?type=report&limit=3")).docs ?? [];
const meetings = (await get("/api/meetings")).meetings ?? [];
const bl = (town.buildings ?? []).find((b) => /^bl_/.test(b.id));
const ag = (town.agents ?? []).find((a) => a.kind === "resident");
const views = [
  ["map", ""], ["building", `#/building/${bl?.id}`], ["report", `#/doc/${reports[0]?.id}`],
  ["meeting", `#/meeting/${meetings[0]?.id}`], ["agent", `#/agent/${ag?.id}`],
  ["grant", `#/grant/${process.env.GRANT ?? "gr_ukrou4zjha"}`], ["manual", "#/manual"], ["bank", "#/bank"],
];
const ONLY = process.env.VIEWS ? process.env.VIEWS.split(",") : null;
const want = (v) => !ONLY || ONLY.includes(v);
const SIZES = (process.argv[2] ?? "laptop,phone").split(",").map((s) => (s === "phone" ? [390, 844, "phone"] : [1280, 800, "laptop"]));

function measure() {
  const parse = (s) => { const m = s.match(/[\d.]+(e-?\d+)?/g); if (!m) return [0, 0, 0, 0]; const n = m.map(Number); return s.startsWith("color(srgb") ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n; }; // color-mix() computes to color(srgb r g b / a), 0..1
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const rootBg = parse(getComputedStyle(document.body).backgroundColor);
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e).backgroundColor; const c = parse(s); if (s !== "rgba(0, 0, 0, 0)" && (c[3] ?? 1) > 0) { stack.push(c); if ((c[3] ?? 1) >= 0.95) break; } } let b = (rootBg[3] ?? 1) > 0 ? rootBg.slice(0, 3) : [20, 21, 28]; for (const c of stack.reverse()) { const a = c[3] ?? 1; b = [0, 1, 2].map((i) => c[i] * a + b[i] * (1 - a)); } return b; };
  const sizes = {}, colors = {}, fams = {}, weights = {}; let lowC = 0, total = 0, tiny = 0; const lows = []; const lowLines = new Set();
  const W = innerWidth, H = innerHeight;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (seen.has(el)) continue; seen.add(el);
    if (el.closest("script,style,noscript")) continue;
    if (el.closest(":disabled,[aria-disabled=true]")) continue; // WCAG 1.4.3 exempts inactive controls
    const rc = el.getBoundingClientRect(); if (rc.width < 1 || rc.height < 1 || rc.bottom < 0 || rc.top > H || rc.right < 0 || rc.left > W) continue;
    const cs = getComputedStyle(el); if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
    total++;
    sizes[cs.fontSize] = (sizes[cs.fontSize] || 0) + 1; colors[cs.color] = (colors[cs.color] || 0) + 1; fams[cs.fontFamily.split(",")[0]] = 1; weights[cs.fontWeight] = 1;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity; // faded rows (opacity) count as dimmer text
    const fg = parse(cs.color), bg = bgOf(el); const a = (fg[3] ?? 1) * op; const fgm = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    const L1 = lum(fgm), L2 = lum(bg); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
    if (cr < (big ? 3 : 4.5)) {
      lowC++; lowLines.add(Math.round(rc.top / 6) + ":" + Math.round(rc.left / 200));
      if (lows.length < 8) lows.push(`${cr.toFixed(2)} ${cs.fontSize} ${cs.color} on rgb(${bg.map(Math.round)}) <${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}> "${t.textContent.trim().slice(0, 28)}"`);
    }
    if (parseFloat(cs.fontSize) < 11) tiny++;
  }
  return { total, lowC, lowLines: lowLines.size, tiny, nSizes: Object.keys(sizes).length, sizes: Object.keys(sizes).sort((a, b) => parseFloat(a) - parseFloat(b)), nColors: Object.keys(colors).length, fams: Object.keys(fams), weights: Object.keys(weights), lows };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const out = [];
const log = (n, name, r) => {
  out.push({ n, name, ...r });
  console.log(n, name.padEnd(process.env.MOCK ? 34 : 9), "texts", r.total, "sizes", r.nSizes, "colors", r.nColors, "lowLines", r.lowLines, "lowEls", r.lowC, "<11px", r.tiny, "| sizes", r.sizes.join(" "));
  if (r.lows.length) console.log("    " + r.lows.join("\n    "));
};
const MOCK_TARGETS = [
  { kind: "agent", id: "ag_noor" }, { kind: "agent", id: "ag_keel" }, { kind: "building", id: "bl_carbon" }, { kind: "building", id: "bl_townhall" },
  { kind: "library" }, { kind: "library", docId: "dc_noor_r2" }, { kind: "library", docId: "review-deck" }, { kind: "meeting", id: "mt_town1" },
  { kind: "intray", id: "bl_carbon" }, { kind: "intray", id: "bl_townhall" }, { kind: "board", id: "bl_carbon" }, { kind: "cabinet", id: "bl_carbon" },
  { kind: "planning" }, { kind: "schedule", id: "bl_carbon" }, { kind: "mod" }, { kind: "grant", id: "gr_ocean" }, { kind: "grant", id: "gr_stress" },
  { kind: "assignment", id: "as_noor2" }, { kind: "session", id: "se_fork1" }, { kind: "manual" }, { kind: "manual", id: "design" }, { kind: "stats" }, { kind: "help", id: "bl_carbon" },
  { kind: "goals" }, { kind: "goals", id: "gl_join" }, { kind: "outbox" }, { kind: "connect" }, { kind: "bank" },
].filter((t) => !process.env.ONLY || process.env.ONLY.split(",").includes(t.kind));
if (process.env.MOCK) {
  for (const [w, h, n] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: n === "phone", isMobile: n === "phone" });
    const page = await ctx.newPage();
    await page.goto(process.env.MOCK, { waitUntil: "load" }); await page.waitForTimeout(2500);
    for (const b of ["Explore the town", "Skip"]) { const x = page.getByText(b).first(); if (await x.isVisible().catch(() => false)) { await x.click().catch(() => {}); await page.waitForTimeout(800); } }
    if (!(await page.evaluate(() => !!window.__muster))) { console.error("no window.__muster: is this a dev (vite) mock build?"); process.exit(1); }
    log(n, "map", await page.evaluate(measure));
    for (const t of MOCK_TARGETS) {
      const label = t.kind + (t.id ? ":" + t.id : "") + (t.docId ? ":" + t.docId : "");
      await page.evaluate((x) => window.__muster.open(x), t); await page.waitForTimeout(900);
      const tabs = page.locator("aside.panel [role=tab], .bank-sheet [role=tab]");
      const names = await tabs.evaluateAll((els) => els.map((e) => e.textContent.trim()));
      for (const [i, tab] of (names.length ? names : [null]).entries()) {
        if (i > 0) { await tabs.nth(i).click().catch(() => {}); await page.waitForTimeout(600); }
        const name = label + (tab ? "/" + tab : "");
        await page.screenshot({ path: `${OUT}/${n}-${name.replace(/[:/ ]/g, "_")}.png` });
        log(n, name, await page.evaluate(measure));
      }
      await page.evaluate(() => window.__muster.open(null)); await page.waitForTimeout(200);
    }
    await ctx.close();
  }
  fs.writeFileSync(`${OUT}/census.json`, JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
}
for (const [w, h, n] of SIZES) {
  // home page (server-rendered "/", pitch card over it on a first visit)
  if (want("home")) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    await p.goto(process.env.HOME_URL ?? HOME + "/", { waitUntil: "networkidle" }).catch(() => {});
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${OUT}/${n}-home.png` });
    log(n, "home", await p.evaluate(measure));
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(base + "?guest", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3000);
  // how-it-works: the first-visit card, before Skip / Watch first
  if (want("hiw")) { await page.screenshot({ path: `${OUT}/${n}-hiw.png` }); log(n, "hiw", await page.evaluate(measure)); }
  for (const b of ["Skip", "Watch first"]) { const l = page.getByRole("button", { name: b }); if (await l.isVisible().catch(() => false)) { await l.click(); await page.waitForTimeout(1000); } }
  for (const [name, hsh] of views) {
    if (!want(name)) continue;
    await page.evaluate((x) => { location.hash = x; }, hsh); await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${n}-${name}.png` });
    log(n, name, await page.evaluate(measure));
  }
  await ctx.close();
}
fs.writeFileSync(`${OUT}/census.json`, JSON.stringify(out, null, 1));
await browser.close();
