/**
 * The web client never drops text it has (Mitchell, 1:1 mt_rt8rbn4ban). A long text may open collapsed to its first
 * `max` characters, cut at a word boundary, but always with a "Show more" that reveals all of it in place (ui.tsx ShowMore).
 * `head` is the collapsed text, `cut` whether anything is hidden.
 */
export function clipText(text: string, max: number): { head: string; cut: boolean } {
  if (text.length <= max) return { head: text, cut: false };
  const slice = text.slice(0, max);
  const space = slice.search(/\s\S*$/);
  return { head: (space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,.;:]+$/, "") + "…", cut: true };
}
