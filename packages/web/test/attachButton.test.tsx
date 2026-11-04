import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachButton } from "../src/panels/AttachButton";

describe("Attach button (1:1 mt_z1b38bwg98)", () => {
  it("says Attach, names the types and limit, and shows uploads in flight", () => {
    const idle = renderToStaticMarkup(<AttachButton media={{ pick: () => undefined, uploading: 0 }} />);
    expect(idle).toContain(">Attach</button>");
    expect(idle).toContain('type="button"'); // never submits the form it sits in
    expect(idle).toContain("up to 8 MiB");
    expect(idle).toContain("paste or drop");
    expect(renderToStaticMarkup(<AttachButton small media={{ pick: () => undefined, uploading: 1 }} />)).toContain('class="btn sm"');
    expect(renderToStaticMarkup(<AttachButton media={{ pick: () => undefined, uploading: 2 }} />)).toContain("Uploading…");
    expect(renderToStaticMarkup(<AttachButton disabled media={{ pick: () => undefined, uploading: 0 }} />)).toContain("disabled");
  });
});
