// @vitest-environment happy-dom
/**
 * Browser errors (gr_cyqzweu6ed step 1): a panel that throws shows "This panel crashed" and posts once, with its panel kind;
 * a page load posts at most MAX_REPORTS_PER_LOAD; window errors and rejections post too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const posts: unknown[] = [];
vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), getApi: async () => ({ reportClientError: async (b: unknown) => { posts.push(b); } }) }));
const { CrashTestPanel, PanelBoundary } = await import("../src/panels/PanelBoundary");
const { installErrorHandlers, MAX_REPORTS_PER_LOAD, reportClientError, resetClientErrorCount } = await import("../src/clientErrors");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, el: HTMLDivElement;
beforeEach(() => {
  posts.length = 0;
  resetClientErrorCount();
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  vi.spyOn(console, "error").mockImplementation(() => undefined); // React logs the caught crash
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.restoreAllMocks(); });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("browser error capture", () => {
  it("a thrown panel shows 'This panel crashed' and posts once with its panel kind", async () => {
    location.hash = "#/crash-test";
    act(() => root.render(<PanelBoundary panel="crash-test"><CrashTestPanel /></PanelBoundary>));
    await flush();
    expect(el.textContent).toContain("This panel crashed: crash test: this panel throws on purpose");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ source: "panel", panel: "crash-test", route: "#/crash-test", message: "crash test: this panel throws on purpose" });
    expect((posts[0] as { stack: string }).stack).toContain("CrashTestPanel");
  });

  it("posts at most MAX_REPORTS_PER_LOAD a page load; window errors and rejections post", async () => {
    const off = installErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("x is undefined"), message: "x is undefined" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." })); // cross-origin: no detail, not sent
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("Failed to fetch") });
    window.dispatchEvent(rejection);
    off();
    for (let i = 0; i < 20; i++) reportClientError("error", new Error(`n${i}`));
    await flush();
    expect(posts).toHaveLength(MAX_REPORTS_PER_LOAD);
    expect(posts.slice(0, 2)).toMatchObject([{ source: "error", message: "x is undefined" }, { source: "rejection", message: "Failed to fetch" }]);
  });
});
