#!/usr/bin/env node
// npm run check:css (grant gr_kvmwutmybu, kr_68eg5yskoo + kr_qge1yo1lmi): the web client's CSS stays on one type scale
// and one palette. Fails when a .css file under packages/web/src has
//   - a font-size that isn't var(--fs-*) or inherit (the scale lives in packages/web/src/type.css), or
//   - a colour literal (#hex, rgb()/hsl()/hwb()/lab()/lch()/oklab()/oklch(), or a named colour such as `white`)
//     outside the :root palette block of type.css. Use var(--token) or color-mix() of tokens instead.
// Prints one line per stray (file:line) and a total; exit 1 when there is any. No dependencies.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "packages/web/src");
const PALETTE = join(src, "type.css");
const NAMED = "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia|brown|crimson|indigo|violet|tomato|salmon|coral|khaki|beige|ivory|lavender|turquoise|tan|plum|orchid|wheat";
const LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|(?<![\\w-])(?:${NAMED})(?![\\w-])`, "i");

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".css")) files.push(p);
  }
})(src);

const strays = [];
for (const file of files.sort()) {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")); // drop comments, keep lines
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  // the palette block: type.css's :root rules may hold literals (and only colour/size custom properties)
  const allowed = [];
  if (file === PALETTE) for (const m of text.matchAll(/:root\s*\{[^}]*\}/g)) allowed.push([m.index, m.index + m[0].length]);
  const inPalette = (i) => allowed.some(([a, b]) => i >= a && i < b);
  // every declaration `prop: value` (custom properties included)
  for (const m of text.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = m;
    if (/[{]/.test(value)) continue;
    const at = m.index;
    if (prop === "font-size" && !/^\s*(var\(--fs-[\w-]+\)|inherit)\s*$/.test(value))
      strays.push(`${relative(root, file)}:${lineOf(at)}: font-size off the scale: ${value.trim()} (use var(--fs-*))`);
    if (prop === "font" && /\d(px|em|rem|pt|%)/.test(value.split("/")[0]) && !/var\(--fs-/.test(value))
      strays.push(`${relative(root, file)}:${lineOf(at)}: font shorthand size off the scale: ${value.trim()}`);
    const lit = value.match(LITERAL);
    if (lit && !inPalette(at) && !/^(font-family|font|content|grid-template-areas|animation(-name)?)$/.test(prop))
      strays.push(`${relative(root, file)}:${lineOf(at)}: colour literal ${lit[0].replace(/\($/, "()")} in ${prop} (use a palette token from type.css)`);
  }
}
for (const s of strays) console.log(s);
console.log(`check:css: ${files.length} files, ${strays.length} stray ${strays.length === 1 ? "value" : "values"}`);
process.exit(strays.length ? 1 : 0);
