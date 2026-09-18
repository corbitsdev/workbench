// A workflow definition's person-facing display name, derived once here so
// every caller reads it the same way — never a scattered `description ??
// name` reimplemented per call site.
import { type } from "arktype";
import { ID_LEAK_PATTERN } from "./id-leak-guard";

const DisplayNameSource = type({
  name: "string",
  "description?": "string | null",
});

/** kebab-case identifier -> Title Case words. Safe over a definition's raw
 * `name` only because `deriveDisplayName` guards out an internal id first. */
export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The display name a definition should render as: its description when
 * set, otherwise a humanized slug. Throws on a malformed shape or when
 * `name`/`description` is itself an internal id, rather than rendering
 * a leak like "Run 737a058d…". */
export function deriveDisplayName(definition: {
  readonly name: string;
  readonly description?: string | null;
}): string {
  const parsed = DisplayNameSource(definition);
  if (parsed instanceof type.errors) {
    throw new Error(`deriveDisplayName: invalid agent definition: ${parsed.summary}`);
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
 * field untouched. */
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
