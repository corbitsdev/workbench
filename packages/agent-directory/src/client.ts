// Browser-safe "what counts as a user-facing agent" logic: filtering out
// the chat anchor machinery's workbench hosts (they are plumbing, not an
// agent a person created), full-text search across the fields a person
// actually reads (never an id), and flagging an instance whose definition
// has since gone missing from the tenant's own listing. Depends directly on
// `@corbits/chat/workbench-host-naming` — a domain package, not app state —
// to identify that plumbing; a host injects only its raw definition/
// instance lists, already fetched from wherever it gets them.

import { type } from "arktype";
import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";

export type UserFacingAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

/**
 * A definition's kebab `name` is its immutable, URL-facing identifier
 * (CL-6413) — the mail handle `createAgentDefinitionCore` binds it to
 * (`@corbits/agent-directory/agent-workflow`'s `input.handle`). The
 * person-facing display name it was created with lands one hop away, on
 * `description`: that same handler seeds `workflowDefinition.description`
 * from the asset's own `displayName`
 * (`vendor/intx/hub-sessions/src/workflow-definition-ensure.ts`), so
 * `deriveDisplayName` reads it from there. A definition created before
 * that seeding existed, or with no description ever set, has no display
 * name to read — `humanizeSlug` backfills one from the identifier itself
 * rather than showing the raw slug as if it were a name.
 */
const DisplayNameSource = type({
  name: "string",
  "description?": "string | null",
});

/** kebab-case identifier -> Title Case words: `"research-analyst"` ->
 * `"Research Analyst"`. Words that aren't hyphen-separated (a name that
 * already reads as prose) pass through with only their case fixed up, so
 * this is safe to run over a definition's raw `name` unconditionally. */
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
 * immutable slug. Throws on a shape that isn't at least `{ name }` — this
 * is a trust boundary, not a formatting helper, so a malformed record
 * fails loudly rather than rendering "undefined".
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
  const { description } = parsed;
  return description !== undefined && description !== null && description !== ""
    ? description
    : humanizeSlug(parsed.name);
}

export type WithDisplayName<T> = T & { readonly displayName: string };

/** Projects `deriveDisplayName` onto a definition, keeping every other
 * field untouched — the read-boundary derivation the ticket calls for,
 * done once here rather than as scattered `??` fallbacks in UI code. */
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

export type UserFacingAgentInstance = {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionName: string;
  readonly address?: string;
};

/** Every definition, minus the chat anchor machinery's workbench hosts —
 * those are internal plumbing, never a user-facing agent. Definitions
 * never need the run-id filter `purposeAgentInstances` below takes:
 * definition rows aren't run rows, so a folded run's own id can never
 * match here — an invited agent's real `definitionId` stays a
 * legitimate, reusable template even though its *instance* is chat
 * plumbing. */
export function purposeAgentDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter((d) => !isWorkbenchHostDefinitionName(d.name));
}

/**
 * `excludeRunIds` additionally drops folded chat runs (invited agents):
 * they self-anchor like a real deployment and launch under a real,
 * user-authored `definitionId` that `isWorkbenchHostDefinitionName` never
 * catches, so the host names them by id instead. Defaults to an empty
 * set so callers without a folded-run source keep the name-only filter.
 */
export function purposeAgentInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  excludeRunIds: ReadonlySet<string> = new Set(),
): readonly T[] {
  return instances.filter(
    (instance) =>
      !isWorkbenchHostDefinitionName(instance.definitionName) &&
      !excludeRunIds.has(instance.id),
  );
}

export function filterDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return definitions;
  return definitions.filter(
    (d) =>
      d.name.toLowerCase().includes(needle) ||
      (d.description ?? "").toLowerCase().includes(needle),
  );
}

export function filterInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return instances;
  return instances.filter((i) =>
    i.definitionName.toLowerCase().includes(needle),
  );
}

/**
 * An instance is orphaned when the tenant's own definitions listing no
 * longer carries its `definitionId` — the definition was deleted or,
 * more commonly, has scrolled past the page's fetch window. A
 * definition row's own FK to the run means this can never mean "no
 * definition ever existed"; it means "not resolvable from here", which
 * is exactly the distinction the UI floor cares about: never hide an
 * instance the page cannot fully explain, mark it instead.
 */
export function isOrphanedInstance(
  instance: Pick<UserFacingAgentInstance, "definitionId">,
  definitionsById: ReadonlyMap<string, unknown>,
): boolean {
  return !definitionsById.has(instance.definitionId);
}

export function definitionsById<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(definitions.map((d) => [d.id, d]));
}
