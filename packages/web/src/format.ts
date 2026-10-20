/** Number formatting shared by panels and the map overlay. */

/** 1234 → "1k", 2_500_000 → "2.5M", 50_000_000 → "50M". */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
