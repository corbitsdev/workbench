// The first definition to find any ancestor match wins, not the nearest
// match — so a nested target must be listed before its container.

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
