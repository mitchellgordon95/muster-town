/**
 * An agent's thought as a line in Talk (grant gr_7h6r66d10i): its inline markdown rendered (bold, code, list items and
 * headings as their own lines) instead of shown as ** and ` characters, with ids still linked by name through DocText.
 */
import { Fragment, type ReactNode } from "react";
import { DocText } from "./Markdown";
import { inlineParts, thoughtLines } from "./thoughtMarkdown";

export function ThoughtText({ text }: { text: string }) {
  const lines = thoughtLines(text);
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i ? <br /> : null}
          {inlineParts(l).map((p, j): ReactNode =>
            p.kind === "bold" ? <strong key={j}><DocText text={p.text} /></strong>
              : p.kind === "code" ? <code key={j}><DocText text={p.text} /></code>
                : <DocText key={j} text={p.text} />)}
        </Fragment>
      ))}
    </>
  );
}
