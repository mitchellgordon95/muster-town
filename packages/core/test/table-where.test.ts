import { describe, expect, it } from "vitest";
import { whereOf } from "../src/table.ts";

// gr_8ve21typt6 step 2: one WHERE builder instead of hand-rolled where.push/params.push at each query.
describe("whereOf", () => {
  it("no conds and no extras: empty sql, no params", () => {
    expect(whereOf({})).toEqual({ sql: "", params: [] });
  });

  it("one cond: col = ?", () => {
    expect(whereOf({ agentId: "ag_1" })).toEqual({ sql: "agentId = ?", params: ["ag_1"] });
  });

  it("skips undefined, null and \"\" (unset filters) but keeps 0 and false", () => {
    expect(whereOf({ a: undefined, b: null, c: "", d: 0, e: false })).toEqual({ sql: "d = ? AND e = ?", params: [0, false] });
  });

  it("array → IN; empty array matches nothing", () => {
    expect(whereOf({ type: ["x", "y"], "d.state": "building" })).toEqual({ sql: "type IN (?, ?) AND d.state = ?", params: ["x", "y", "building"] });
    expect(whereOf({ type: [] })).toEqual({ sql: "0 = 1", params: [] });
  });

  it("extra raw fragments follow the conds with their params in order; falsy entries skipped", () => {
    const since: number | undefined = 5;
    expect(whereOf({ buildingId: "bl_1" }, [
      { sql: "(state != 'draft' OR authorId = ?)", params: ["ag_2"] },
      false,
      undefined,
      since !== undefined && { sql: "id > ?", params: [since] },
      { sql: "status != 'draft'", params: [] },
    ])).toEqual({ sql: "buildingId = ? AND (state != 'draft' OR authorId = ?) AND id > ? AND status != 'draft'", params: ["bl_1", "ag_2", 5] });
  });

  it("refuses a column name that isn't an identifier", () => {
    expect(() => whereOf({ "a = 1 OR 1": "x" })).toThrow(/bad column/);
  });
});
