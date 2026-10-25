/** Number formatting shared by panels and the map overlay. */

/** The stoplight's label (board row, map banner tooltip): green Running, yellow Partly blocked, red Blocked. */
export function stoplightLabel(light: "green" | "yellow" | "red"): string {
  return light === "green" ? "Running" : light === "yellow" ? "Partly blocked" : "Blocked";
}

/** 1234 → "1k", 2_500_000 → "2.5M", 4_000_000 → "4M", 50_000_000 → "50M". */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Token count → the "M tokens" input's text: 275_000_000 → "275", 500_000 → "0.5". */
export function toMillions(n: number): string {
  return String(Number((n / 1e6).toFixed(6)));
}

/** The "M tokens" input's text → a whole token count ("1.25" → 1_250_000); NaN when it isn't a number. */
export function fromMillions(s: string): number {
  const t = s.replace(/[,_\s]/g, "");
  return t === "" ? NaN : Math.round(Number(t) * 1e6);
}
