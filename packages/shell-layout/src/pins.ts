// User-curated global pins for the contextual panel middle band. Same list
// on every page. Persistence is host-supplied storage (typically
// `localStorage`) under a host-supplied key — this module has no branded
// storage key of its own, so two hosts (or a host and its tests) never
// collide on the same key by accident.

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

export function loadPins(
  storage: Pick<Storage, "getItem">,
  key: string,
): readonly Pin[] {
  const raw = storage.getItem(key);
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
  storage: Pick<Storage, "setItem">,
  key: string,
): void {
  storage.setItem(key, JSON.stringify(pins));
}

export function togglePin(pins: readonly Pin[], pin: Pin): readonly Pin[] {
  const exists = pins.some((p) => p.id === pin.id && p.kind === pin.kind);
  if (exists) {
    return pins.filter((p) => !(p.id === pin.id && p.kind === pin.kind));
  }
  return [...pins, pin];
}
