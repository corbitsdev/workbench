// A workflow definition's person-facing display name, derived once here
// so every caller that decides "what does this agent look like to a
// person" reads it the same way — never a scattered `description ?? name`
// (or worse, a raw address/run id) reimplemented per call site.
//
// Lives in `@corbits/chat` rather than `@corbits/agent-directory` (which
// originated this logic, CL-6413) because `@corbits/agent-directory`
// itself depends on `@corbits/chat` (`workbench-host-naming`); a reverse
// dependency would be circular. `@corbits/agent-directory/client.ts`
// re-exports `deriveDisplayName`/`humanizeSlug` from here for its existing
// callers rather than keeping a second copy that could drift.
import { type } from "arktype";
import { ID_LEAK_PATTERN } from "./id-leak-guard";

const DisplayNameSource = type({
  name: "string",
  "description?": "string | null",
});

/** kebab-case identifier -> Title Case words: `"research-analyst"` ->
 * `"Research Analyst"`. Words that aren't hyphen-separated (a name that
 * already reads as prose) pass through with only their case fixed up, so
 * this is safe to run over a definition's raw `name` unconditionally —
 * PROVIDED that `name` is never an internal id in disguise; see
 * `deriveDisplayName`'s own guard for why the raw run-id case never
 * reaches this function at all. */
export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The display name a definition should render as: its own description
 * when one was set at creation, otherwise a humanized reading of its
 * immutable slug. A whitespace-only description reads as absent — never
 * a blank display name — since it carries nothing a person actually
 * typed. Throws on a shape that isn't at least `{ name }` — this is a
 * trust boundary, not a formatting helper, so a malformed record fails
 * loudly rather than rendering "undefined".
 *
 * Also throws when `name` is itself an internal-id shape (`run_…`,
 * `wfd_…`, …, see `./id-leak-guard`) — the product rule is that a person
 * never sees an internal identifier, so a caller that reaches this
 * function with a run id where a definition's slug belongs gets a loud
 * failure instead of a Title-Cased leak like "Run 737a058d…" (CL-6471).
 */
export function deriveDisplayName(definition: {
  readonly name: string;
  readonly description?: string | null;
}): string {
  const parsed = DisplayNameSource(definition);
  if (parsed instanceof type.errors) {
    throw new Error(
      `deriveDisplayName: invalid agent definition: ${parsed.summary}`,
    );
  }
  const description = parsed.description?.trim();
  if (description !== undefined && description !== "") {
    if (ID_LEAK_PATTERN.test(description)) {
      throw new Error(
        `deriveDisplayName: description "${description}" for definition ` +
          `"${parsed.name}" carries an internal identifier; refusing to ` +
          "render it as a display name",
      );
    }
    return description;
  }
  if (ID_LEAK_PATTERN.test(parsed.name)) {
    throw new Error(
      `deriveDisplayName: definition name "${parsed.name}" is an internal ` +
        "identifier, not a slug; refusing to humanize it into a fake " +
        "display name",
    );
  }
  return humanizeSlug(parsed.name);
}

export type UserFacingAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

export type WithDisplayName<T> = T & { readonly displayName: string };

/** Projects `deriveDisplayName` onto a definition, keeping every other
 * field untouched — the read-boundary derivation done once here rather
 * than as scattered `??` fallbacks in UI code. */
export function withDisplayName<T extends UserFacingAgentDefinition>(
  definition: T,
): WithDisplayName<T> {
  return { ...definition, displayName: deriveDisplayName(definition) };
}

export function withDisplayNames<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): readonly WithDisplayName<T>[] {
  return definitions.map(withDisplayName);
}
