/** The operating manual split at its h2 headings: the sheet's table of contents and the `/#/manual/<section>` slugs. */
interface ManualSection { title: string; slug: string; body: string }

export const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** `intro` is the text before the first `## `; a leading `# ` title line (the doc's title) is dropped. */
export function manualSections(body: string): { intro: string; sections: ManualSection[] } {
  const parts = body.replace(/^# .*\n+/, "").split(/^## +/m);
  const intro = parts.shift()!.trim();
  const sections = parts.map((p) => {
    const nl = p.indexOf("\n");
    const title = (nl < 0 ? p : p.slice(0, nl)).trim();
    return { title, slug: slugOf(title), body: nl < 0 ? "" : p.slice(nl + 1).trim() };
  });
  return { intro, sections };
}
