// @vitest-environment happy-dom
// grant gr_4csjpgh346 kr_pm0fmsiaxs: docs keep rich HTML (style, class, folds, figures, media, keys, highlights);
// scripts, event handlers and javascript: URLs still never pass.
import { describe, expect, it } from "vitest";
import { sanitize } from "../src/panels/Markdown";

const dom = (html: string) => { const d = document.createElement("div"); d.innerHTML = sanitize(html); return d; };

describe("sanitize: the wider allowlist", () => {
  it("keeps style and class", () => {
    const d = dom('<div class="callout wide" style="color: var(--accent); padding: 4px">hi</div>');
    const el = d.querySelector("div")!;
    expect(el.getAttribute("class")).toBe("callout wide");
    expect(el.getAttribute("style")).toContain("padding: 4px");
  });
  it("keeps details and summary, open or not", () => {
    const d = dom("<details open><summary>More</summary><p>inside</p></details>");
    expect(d.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(d.querySelector("summary")?.textContent).toBe("More");
    expect(d.querySelector("details p")?.textContent).toBe("inside");
  });
  it("keeps figure and figcaption", () => {
    const d = dom('<figure><img src="/api/media/mf_aaaaaaaaaa.png" alt="a"><figcaption>The caption</figcaption></figure>');
    expect(d.querySelector("figure img")).not.toBeNull();
    expect(d.querySelector("figcaption")?.textContent).toBe("The caption");
  });
  it("keeps video with controls and a source, but never autoplay", () => {
    const d = dom('<video controls autoplay loop muted width="320" poster="/api/media/mf_bbbbbbbbbb.png"><source src="/api/media/mf_cccccccccc.webm" type="video/webm"></video>');
    const v = d.querySelector("video")!;
    expect(v.hasAttribute("controls")).toBe(true);
    expect(v.hasAttribute("autoplay")).toBe(false);
    expect(v.getAttribute("width")).toBe("320");
    expect(d.querySelector("source")?.getAttribute("src")).toBe("/api/media/mf_cccccccccc.webm");
  });
  it("keeps audio with controls, but never autoplay", () => {
    const a = dom('<audio controls autoplay src="/api/media/mf_dddddddddd.mp3"></audio>').querySelector("audio")!;
    expect(a.hasAttribute("controls")).toBe(true);
    expect(a.hasAttribute("autoplay")).toBe(false);
  });
  it("keeps kbd and mark", () => {
    const d = dom("Press <kbd>Esc</kbd> to <mark>close</mark>");
    expect(d.querySelector("kbd")?.textContent).toBe("Esc");
    expect(d.querySelector("mark")?.textContent).toBe("close");
  });
  it("keeps img width and height (and the author's class beside md-media)", () => {
    const img = dom('<img src="/api/media/mf_eeeeeeeeee.png" width="120" height="80" class="mine">').querySelector("img")!;
    expect(img.getAttribute("width")).toBe("120");
    expect(img.getAttribute("height")).toBe("80");
    expect(img.classList.contains("mine")).toBe(true);
    expect(img.classList.contains("md-media")).toBe(true);
  });
});

describe("sanitize: what still never passes", () => {
  it("strips <script> and onclick", () => {
    const d = dom('<p onclick="alert(1)">x</p><script>alert(2)</script><img src="x.png" onerror="alert(3)">');
    expect(d.querySelector("script")).toBeNull();
    expect(d.innerHTML).not.toMatch(/onclick|onerror|alert/);
  });
  it("strips javascript: URLs, also when spaced or cased", () => {
    const d = dom('<a href=" JaVa\tScript:alert(1)">a</a><video poster="javascript:alert(2)"></video>');
    expect(d.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(d.querySelector("video")?.hasAttribute("poster")).toBe(false);
  });
  it("drops a style that could run code or sit over the town", () => {
    const d = dom('<div style="background:url(javascript:alert(1))">a</div><div style="position: fixed; inset: 0">b</div><div style="width: expression(alert(1))">c</div>');
    for (const el of d.querySelectorAll("div")) expect(el.hasAttribute("style")).toBe(false);
  });
  it("still drops style, iframe and form elements", () => {
    const d = dom("<style>body{}</style><iframe></iframe><form><input></form>ok");
    expect(d.querySelector("style, iframe, form")).toBeNull();
  });
});

describe("page docs: the sandboxed frame's srcdoc", () => {
  it("puts our doctype, a no-network CSP and the town's variables before the page, dropping the page's own doctype", async () => {
    const { pageSrcDoc } = await import("../src/panels/PageView");
    const s = pageSrcDoc("<!DOCTYPE html><html><body><script>draw()</script></body></html>", { "--accent": "#7cc4ff", "--bad}x": "red", "--text": "#fff</style><script>" }, "https://muster.town");
    expect(s.startsWith("<!doctype html>")).toBe(true);
    expect(s.match(/<!doctype/gi)).toHaveLength(1);
    expect(s).toContain("default-src 'none'");
    expect(s).toContain("img-src data: blob: https://muster.town");
    expect(s).toContain("--accent: #7cc4ff;");
    expect(s).not.toContain("--bad}x");
    expect(s).not.toContain("#fff</style>");
    expect(s).toContain("<script>draw()</script>");
  });
});
