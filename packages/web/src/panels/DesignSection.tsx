/**
 * The manual's "Design" section (grant gr_kvmwutmybu, kr_z4junko6nt): the town's type scale and its 24 colour tokens, as
 * they are declared in type.css's two :root blocks, plus a before/after contact sheet of the work that made them one
 * system. Values are read from the page's own CSS at render time, so the section can't drift from the code.
 * The type specimen is a picture (an SVG built from the --fs-* values): drawn as page text it would put all 7 steps on
 * one screen, and the census holds every view to ≤6 sizes.
 */
import { useMemo } from "react";
import { API_BASE } from "../api";

const STEPS: [string, string][] = [
  ["--fs-xs", "uppercase labels, timestamps, chips"],
  ["--fs-sm", "secondary text, small buttons, code"],
  ["--fs-md", "body text in panels"],
  ["--fs-lg", "panel titles, paper-sheet body, big buttons"],
  ["--fs-xl", "close ×, sheet subheads, phone headlines"],
  ["--fs-xxl", "sheet headlines on short screens"],
  ["--fs-display", "paper-sheet headline"],
];

const GROUPS: [string, string, string[]][] = [
  ["Surfaces and lines", "the dark town panels, darkest first, and their borders", ["--bg", "--panel", "--panel-2", "--raised", "--line", "--line-2"]],
  ["Text", "brightest first; every one reads at 4.5:1 or better on --panel-2", ["--text", "--soft", "--muted", "--faint"]],
  ["Meaning", "links, status, meetings, money", ["--accent", "--link", "--ok", "--warn", "--bad", "--meet", "--gold"]],
  ["Paper", "the manual, the how-it-works card and the home page", ["--paper", "--ink", "--blue", "--green", "--amber"]],
  ["Base", "for mixing: shadows and highlights", ["--black", "--white"]],
];

/** The contact sheet: live 0af4874 (before the grant) beside live aa6f4fbc (after), agent Talk and the Bank, 1280×800. */
const CONTACT = "/api/media/mf_5ke5yff43d.png";

const cssVar = (name: string) => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/** 360 wide: a phone sheet (~330 px) scales it to ~0.9, so the 11 px step still reads (560 shrank it to ~6 px). */
const W = 360;

function specimen(steps: { name: string; px: number }[], ink: string): string {
  let y = 0;
  const rows = steps.map(({ name, px }) => {
    y += Math.round(px * 1.35) + 6;
    return `<text x="0" y="${y}" font-size="${px}" fill="${ink}" font-family="system-ui, sans-serif">Muster Town</text>`
      + `<text x="${W}" y="${y}" font-size="13" fill="${ink}" font-family="ui-monospace, monospace" text-anchor="end">${name} ${px}px</text>`;
  }).join("");
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 10}" viewBox="0 0 ${W} ${y + 10}">${rows}</svg>`)}`;
}

export function DesignSection() {
  const steps = useMemo(() => STEPS.map(([name, use]) => ({ name, use, px: parseFloat(cssVar(name)) || 0 })), []);
  const img = useMemo(() => specimen(steps, cssVar("--ink")), [steps]);
  return (
    <div className="manual-md design">
      <p>Every word on screen uses one of seven type steps and every colour is one of 24 named tokens (packages/web/src/type.css). A check in CI (<code>npm run check:css</code>) fails any stylesheet that adds a size or a colour outside them.</p>
      <h4>Type scale</h4>
      <img className="design-specimen" src={img} alt={steps.map((s) => `${s.name} ${s.px}px`).join(", ")} />
      <table className="design-steps">
        <tbody>{steps.map((s) => <tr key={s.name}><td><code>{s.name}</code></td><td>{s.px}px</td><td>{s.use}</td></tr>)}</tbody>
      </table>
      <h4>Colour tokens</h4>
      {GROUPS.map(([title, role, names]) => (
        <div key={title} className="design-group">
          <p><b>{title}</b>: {role}</p>
          <div className="design-swatches">
            {names.map((n) => (
              <div key={n} className="design-swatch">
                <span className="design-chip" style={{ background: `var(${n})` }} />
                <code>{n}</code>
                <span>{cssVar(n)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <h4>Before and after</h4>
      <p>Left, the town on 4 November 2026 before this work; right, after it: agent timestamps and the Bank's labels went from dim grey (under 4.5:1) to readable.</p>
      <a href={API_BASE + CONTACT} target="_blank" rel="noreferrer"><img className="design-contact" src={API_BASE + CONTACT} alt="Before and after: the agent panel's Talk tab and the Bank's Donate tab, 1280×800" /></a>
    </div>
  );
}
