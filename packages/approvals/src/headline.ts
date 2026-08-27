// The one display concern this package owns: the human-readable line an
// approval is described by. Pure string work over the tool snapshot an
// approval already carries, with no database or server dependency, so the
// browser can compose the same headline the hub-side tools do — hence its
// own module and `./headline` export rather than living beside the
// grant-allowance gate.

function stringField(source: object, field: string): string | undefined {
  if (!(field in source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Builds the headline for an approval. Prefers the tool's own
 * `description` — written by the tool's author to be human-readable —
 * over its bare `name`, which is a machine identifier. When the live
 * call's arguments carry a `title` (a tool author's own convention for
 * per-invocation context, e.g. "finalize this piece of collateral titled
 * X"), it is appended so the headline reflects what THIS approval is
 * actually about, not just which tool is asking.
 */
export function headlineFor(
  toolDefinition: unknown,
  toolArguments: unknown,
): string {
  const base =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? (stringField(toolDefinition, "description") ??
        stringField(toolDefinition, "name"))
      : undefined;
  const headline = base ?? "Run a tool";
  const title =
    typeof toolArguments === "object" && toolArguments !== null
      ? stringField(toolArguments, "title")
      : undefined;
  return title === undefined ? headline : `${headline}: "${title}"`;
}
