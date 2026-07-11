const ENVELOPE_KEYS = ["artifact", "input", "args", "params"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap a single-level args envelope. Models sometimes nest a tool's
 * arguments under one wrapper key (`{ artifact: { title, ... } }`) instead of
 * passing them flat; rather than failing validation and inviting an identical
 * retry, merge the nested object up. Only fires when exactly one recognized
 * envelope key is object-valued AND at least one required key is missing at
 * the top level — flat args (and ambiguous shapes) pass through untouched.
 * Sibling top-level keys are kept; the envelope wins conflicts.
 *
 * Caveat: a tool whose schema has a REAL object param named artifact/input/
 * args/params would be mangled here whenever a required key is also omitted
 * (the legitimate object gets merged up). Callers must not adopt this helper
 * for tools that use those names as object-valued parameters.
 */
export function unwrapArgsEnvelope(
  args: Record<string, unknown>,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (requiredKeys.every((key) => key in args)) return args;
  const candidates = ENVELOPE_KEYS.filter((key) => isPlainObject(args[key]));
  if (candidates.length !== 1) return args;
  const envelopeKey = candidates[0] as string;
  const { [envelopeKey]: nested, ...rest } = args;
  return { ...rest, ...(nested as Record<string, unknown>) };
}
