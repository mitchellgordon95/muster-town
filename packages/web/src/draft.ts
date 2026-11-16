/**
 * Form drafts (Mitchell's nit, 2026-11-16 meeting): what a human has half typed into a form survives the form closing
 * (the panel switched, the sheet shut, the map clicked) and a reload of the tab. `useDraft(key, initial)` is `useState`
 * whose value is also kept in sessionStorage under `muster.draft.<key>` while it differs from `initial`; setting it back to
 * `initial` (a form's reset after it is sent) forgets it, and `clearDraft(key)` forgets it for a form that closes on send.
 * The key names the form and what it is about (`"flag:" + buildingId`), so two forms never share a draft.
 * Never use it for a secret (an API key, a token, a secret's value): those stay in plain `useState`.
 */
import { useCallback, useRef, useState } from "react";

const PREFIX = "muster.draft.";
const memory = new Map<string, string>(); // when sessionStorage is missing or refuses (a private window)

function storage(): Storage | null { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } }

function readRaw(key: string): string | null {
  try { const s = storage(); if (s) return s.getItem(PREFIX + key); } catch { /* fall through */ }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, raw: string | null) {
  if (raw === null) memory.delete(key); else memory.set(key, raw);
  try { const s = storage(); if (s) { if (raw === null) s.removeItem(PREFIX + key); else s.setItem(PREFIX + key, raw); } } catch { /* memory has it */ }
}

/** Forget a form's draft (call it after the form is sent, when the form closes instead of resetting). Ending the key
 *  with ":" forgets every draft under it (a whole form keyed `"ask:" + id + ":<field>"`). */
export function clearDraft(key: string) {
  if (!key.endsWith(":")) { writeRaw(key, null); return; }
  for (const k of [...memory.keys()]) if (k.startsWith(key)) memory.delete(k);
  try {
    const s = storage(); if (!s) return;
    const all: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(PREFIX + key)) all.push(k); }
    for (const k of all) s.removeItem(k);
  } catch { /* nothing kept there */ }
}

type SetDraft<T> = (next: T | ((prev: T) => T)) => void;

function load<T>(key: string, fallback: string): T {
  const raw = readRaw(key);
  if (raw !== null) { try { return JSON.parse(raw) as T; } catch { clearDraft(key); } }
  return JSON.parse(fallback) as T;
}

/** `useState` that remembers what was typed until it is sent: see the file comment. A new key loads that key's draft. */
export function useDraft<T>(key: string, initial: T | (() => T)): [T, SetDraft<T>] {
  const base = useRef<{ key: string; json: string } | null>(null);
  if (base.current === null || base.current.key !== key) {
    base.current = { key, json: JSON.stringify(typeof initial === "function" ? (initial as () => T)() : initial) ?? "null" };
  }
  const json = base.current.json;
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: load<T>(key, json) }));
  const set = useCallback<SetDraft<T>>((next) => {
    setState((prev) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(prev.value) : next;
      const out = JSON.stringify(v) ?? "null";
      writeRaw(key, out === json ? null : out);
      return { key, value: v };
    });
  }, [key, json]);
  if (state.key !== key) {
    const value = load<T>(key, json);
    setState({ key, value });
    return [value, set];
  }
  return [state.value, set];
}
