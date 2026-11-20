import { describe, expect, it } from "vitest";
import { BRIDGE_SHIM, checkBridgeMessage } from "../src/panels/pluginBridge";

const RW = ["docs.read", "docs.write"];

describe("the plugin bridge (docs/plugins.md)", () => {
  it("ignores what is not a bridge request", () => {
    for (const d of [null, "hi", 3, {}, { muster: "other", id: 1 }, { muster: "plugin" }, { muster: "plugin", id: {} }]) expect(checkBridgeMessage(d, RW)).toBeNull();
  });

  it("passes known calls through with their checked params", () => {
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "town.hello" }, [])).toEqual({ id: 1, ok: true, call: { method: "town.hello" } });
    expect(checkBridgeMessage({ muster: "plugin", id: 2, method: "docs.list", params: { state: "draft", limit: 5, extra: 1 } }, RW))
      .toEqual({ id: 2, ok: true, call: { method: "docs.list", params: { state: "draft", limit: 5 } } });
    expect(checkBridgeMessage({ muster: "plugin", id: 3, method: "docs.write", params: { title: "T", body: "B" } }, RW))
      .toEqual({ id: 3, ok: true, call: { method: "docs.write", params: { title: "T", body: "B", state: "draft" } } });
  });

  it("refuses unknown methods, missing scopes and bad params, saying why", () => {
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "fetch" }, RW)).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown bridge method/) });
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "docs.write", params: { title: "T", body: "" } }, ["docs.read"])).toMatchObject({ ok: false, code: "forbidden" });
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "docs.list" }, [])).toMatchObject({ ok: false, code: "forbidden" });
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "docs.list", params: { state: "library" } }, RW)).toMatchObject({ ok: false });
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "docs.read", params: {} }, RW)).toMatchObject({ ok: false });
    expect(checkBridgeMessage({ muster: "plugin", id: 1, method: "docs.write", params: { title: " ", body: "" } }, RW)).toMatchObject({ ok: false });
  });

  it("the shim answers only its parent", () => {
    expect(BRIDGE_SHIM).toContain("e.source!==parent");
    expect(BRIDGE_SHIM).toMatch(/^<script>[\s\S]*<\/script>$/);
  });
});
