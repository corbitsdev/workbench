// Mirrored from packages/chat/src (see docs/chat-wire-contract.md).

// One derivation for "what does this agent look like to a person", never a
// scattered `description ?? name` reimplemented per call site.
import { type } from "arktype";
import { ID_LEAK_PATTERN } from "./id-leak-guard";

const DisplayNameSource = type({
  name: "string",
  "description?": "string | null",
});

// Safe to run over a raw `name` only because `deriveDisplayName` already
// guards against an internal id reaching this function.
export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

// A trust boundary, not a formatter: throws on a malformed record and on a
// `name` that is itself an internal id, rather than leaking one into a
// rendered display name.
export function deriveDisplayName(definition: {
  readonly name: string;
  readonly description?: string | null;
}): string {
  const parsed = DisplayNameSource(definition);
  if (parsed instanceof type.errors) {
    throw new Error(`deriveDisplayName: invalid agent record: ${parsed.summary}`);
  }
  const description = parsed.description?.trim();
  if (description !== undefined && description !== "") {
    if (ID_LEAK_PATTERN.test(description)) {
      throw new Error(
        `deriveDisplayName: description "${description}" for agent record ` +
          `"${parsed.name}" carries an internal identifier; refusing to ` +
          "render it as a display name",
      );
    }
    return description;
  }
  if (ID_LEAK_PATTERN.test(parsed.name)) {
    throw new Error(
      `deriveDisplayName: agent record name "${parsed.name}" is an internal ` +
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

// Read-boundary derivation, done once rather than as scattered `??`
// fallbacks in UI code.
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
