// Turns the element a pointer event landed on into a typed target, the same
// way a router turns a path into a typed route: an ordered list of
// selector-scoped resolvers, each tried in turn against `origin.closest()`
// so a click anywhere inside a row still resolves to that row. The first
// *definition* to find any ancestor match wins — not the definition whose
// match is nearest — so a target nested inside another (e.g. a profile face
// inside a channel row) must be listed before its container, or the
// container's definition will win even though it matches farther away.
// Callers own what `T` is — this module only owns the walk.

export type TargetDefinition<T> = {
  /** A CSS selector `Element.closest()` can match against. */
  readonly selector: string;
  /** Builds the typed target from the matched element, or opts out with `null`
   * (e.g. a channel row missing its id) so resolution falls through to the
   * next definition. */
  readonly resolve: (element: Element) => T | null;
};

export function resolveTarget<T, F>(
  origin: EventTarget | null,
  definitions: readonly TargetDefinition<T>[],
  fallback: F,
): T | F {
  if (!(origin instanceof Element)) return fallback;
  for (const definition of definitions) {
    const matched = origin.closest(definition.selector);
    if (matched === null) continue;
    const resolved = definition.resolve(matched);
    if (resolved !== null) return resolved;
  }
  return fallback;
}
