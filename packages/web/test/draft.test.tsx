// @vitest-environment happy-dom
/**
 * Form drafts (Mitchell's nit, 2026-11-16): a half-filled form survives the form closing, sending it forgets the draft,
 * and a draft is only kept while it differs from the form's starting value.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearDraft, useDraft } from "../src/draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let set: (v: string) => void = () => {};
function Form({ k, initial = "" }: { k: string; initial?: string }) {
  const [text, setText] = useDraft(k, initial);
  set = setText;
  return <input value={text} readOnly />;
}

let root: Root | null = null;
const mount = (el: JSX.Element) => { const div = document.createElement("div"); root = createRoot(div); act(() => root!.render(el)); return div; };
const unmount = () => { act(() => root?.unmount()); root = null; };
afterEach(() => { unmount(); sessionStorage.clear(); });

describe("useDraft", () => {
  it("keeps what was typed when the form closes and opens again", () => {
    mount(<Form k="meeting:bl_a:title" />);
    act(() => set("Plan the launch"));
    unmount();
    const div = mount(<Form k="meeting:bl_a:title" />);
    expect(div.querySelector("input")!.value).toBe("Plan the launch");
    expect(sessionStorage.getItem("muster.draft.meeting:bl_a:title")).toBe(JSON.stringify("Plan the launch"));
  });

  it("forgets the draft when the value goes back to where the form started (a reset after sending)", () => {
    mount(<Form k="flag:text" />);
    act(() => set("Fix the hydrant"));
    act(() => set(""));
    expect(sessionStorage.getItem("muster.draft.flag:text")).toBeNull();
    unmount();
    expect(mount(<Form k="flag:text" />).querySelector("input")!.value).toBe("");
  });

  it("starts from a saved value it is keyed by, and keeps two forms apart", () => {
    mount(<Form k="goal:g1:edit" initial="Old words" />);
    act(() => set("New words"));
    unmount();
    expect(mount(<Form k="goal:g2:edit" initial="Other goal" />).querySelector("input")!.value).toBe("Other goal");
    unmount();
    expect(mount(<Form k="goal:g1:edit" initial="Old words" />).querySelector("input")!.value).toBe("New words");
  });

  it("clearDraft forgets one key, or every key under a prefix ending in ':'", () => {
    sessionStorage.setItem("muster.draft.ask:a1:note", '"x"');
    sessionStorage.setItem("muster.draft.ask:a1:words", '"y"');
    sessionStorage.setItem("muster.draft.ask:a2:note", '"z"');
    clearDraft("ask:a1:");
    expect(sessionStorage.getItem("muster.draft.ask:a1:note")).toBeNull();
    expect(sessionStorage.getItem("muster.draft.ask:a1:words")).toBeNull();
    expect(sessionStorage.getItem("muster.draft.ask:a2:note")).toBe('"z"');
    clearDraft("ask:a2:note");
    expect(sessionStorage.length).toBe(0);
  });
});
