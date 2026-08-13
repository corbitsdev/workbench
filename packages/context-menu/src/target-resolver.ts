// Turns the element a pointer event landed on into a typed target, the same
// way a router turns a path into a typed route: an ordered list of
// selector-scoped resolvers, first match wins, closest-ancestor semantics so
// a click anywhere inside a row still resolves to that row. Callers own what
// `T` is — this module only owns the walk.

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
