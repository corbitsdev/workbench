// User-curated global pins for the contextual panel middle band. Same list
// on every page. Persistence is localStorage so pins survive reloads without
// a hub endpoint yet.

import { type } from "arktype";

export const PinKind = type("'channel' | 'agent' | 'routine'");
export type PinKind = typeof PinKind.infer;

export const Pin = type({
  id: "string",
  kind: PinKind,
  label: "string",
  href: "string",
});
export type Pin = typeof Pin.infer;

const STORAGE_KEY = "workbench.shell.pins";

export function loadPins(
  storage: Pick<Storage, "getItem"> = globalThis.localStorage,
): readonly Pin[] {
  if (typeof storage?.getItem !== "function") return [];
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const pins: Pin[] = [];
  for (const entry of parsed) {
    const result = Pin(entry);
    if (result instanceof type.errors) continue;
    pins.push(result);
  }
  return pins;
}

export function savePins(
  pins: readonly Pin[],
  storage: Pick<Storage, "setItem"> = globalThis.localStorage,
): void {
  if (typeof storage?.setItem !== "function") return;
  storage.setItem(STORAGE_KEY, JSON.stringify(pins));
}

export function togglePin(
  pins: readonly Pin[],
  pin: Pin,
): readonly Pin[] {
  const exists = pins.some((p) => p.id === pin.id && p.kind === pin.kind);
  if (exists) {
    return pins.filter((p) => !(p.id === pin.id && p.kind === pin.kind));
  }
  return [...pins, pin];
}
