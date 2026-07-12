import { type } from "arktype";
import { CREDENTIAL_PROVIDER_CATALOG } from "./governance";

/**
 * The preferences registry: the single, hand-maintained source of truth for
 * every per-member setting the workbench exposes. Each entry self-describes its
 * key, control type, default, copy, and category so both the hub (write
 * validation + resolved reads) and the web settings surface are driven entirely
 * by this list — adding a setting is a registration here, never a schema or UI
 * change scattered across apps.
 *
 * Values persist in the open `MemberPreferences` jsonb map (no new storage);
 * this registry is the contract the hub validates writes against.
 */

export const PREFERENCE_CATEGORIES = [
  "Agent",
  "Automations",
  "Notifications",
  "Inbox",
  "General",
] as const;

export const PreferenceCategorySchema = type(
  "'Agent' | 'Automations' | 'Notifications' | 'Inbox' | 'General'",
);
export type PreferenceCategory = typeof PreferenceCategorySchema.infer;

export const PreferenceOptionSchema = type({
  value: "string",
  label: "string",
});
export type PreferenceOption = typeof PreferenceOptionSchema.infer;

/**
 * `boolean` renders a toggle, `select` a dropdown over `options`, and `hourUtc`
 * an hour picker whose value is the UTC hour (0..23) stored server-side while
 * the UI displays the caller's local time.
 */
export const PreferenceEntrySchema = type({
  key: "string",
  type: "'boolean' | 'select' | 'hourUtc'",
  default: "boolean | string | number",
  label: "string",
  description: "string",
  category: PreferenceCategorySchema,
  "options?": PreferenceOptionSchema.array(),
});
export type PreferenceEntry = typeof PreferenceEntrySchema.infer;

const PREFERENCE_REGISTRY_BASE: readonly PreferenceEntry[] = [
  {
    key: "agentAutonomy",
    type: "select",
    default: "prepare_only",
    label: "Agent autonomy",
    description: "How far Myra may go on your behalf.",
    category: "Agent",
    options: [
      { value: "prepare_only", label: "Prepare only" },
      { value: "execute_with_gates", label: "Execute with gates" },
    ],
  },
  {
    key: "briefHourUtc",
    type: "hourUtc",
    default: 13,
    label: "Morning brief time",
    description: "When your morning brief arrives.",
    category: "Automations",
  },
  {
    key: "notifyInboxMail",
    type: "boolean",
    default: true,
    label: "New inbox mail",
    description: "Notify me when a new message lands in my inbox.",
    category: "Notifications",
  },
  {
    key: "onboardingTourDone",
    type: "boolean",
    default: false,
    label: "Onboarding tour completed",
    description:
      "Turn this off to see the guided tour again on your next visit.",
    category: "General",
  },
  {
    key: "notifyGateAsks",
    type: "boolean",
    default: true,
    label: "Approval requests",
    description: "Notify me when an agent needs my approval to proceed.",
    category: "Notifications",
  },
  {
    key: "taskMailEnabled",
    type: "boolean",
    default: true,
    label: "Task activity mail",
    description:
      "Notify me in my inbox when a task is created for me, assigned to me, or waiting on me.",
    category: "Notifications",
  },
  // Tasks toggles from the task design spike. Triage's own task creation
  // defaults ON so prepare-only members keep getting the tasks it already
  // prepares today; the other two default OFF because they are additive
  // behaviors (pushing a task to an external adapter, surfacing done work)
  // that must not change existing behavior for a member who never opts in.
  // Task-event mail is governed by `taskMailEnabled` above.
  {
    key: "tasksTriageCreate",
    type: "boolean",
    default: true,
    label: "Triage may create tasks",
    description:
      "Let Myra's inbox triage leave a task behind for an actionable message.",
    category: "Automations",
  },
  {
    key: "tasksAutoSendAdapter",
    type: "boolean",
    default: false,
    label: "Auto-send tasks to CRM",
    description:
      "Push new tasks to your connected CRM/tracker automatically instead of sending them on request.",
    category: "Automations",
  },
  {
    key: "tasksShowCompleted",
    type: "boolean",
    default: false,
    label: "Show completed tasks",
    description: "Include done and cancelled tasks in your task list.",
    category: "Inbox",
  },
];

/**
 * Catalog of sources the morning brief can pull from — every
 * `CREDENTIAL_PROVIDER_CATALOG` entry tagged `briefSource` (see
 * `governance.ts`). Adding a source is purely additive: tag the provider's
 * catalog entry and, when it is wired into an intake step, check
 * `enabledSources` there. No registry restructuring is needed and no
 * composer code changes. `granola` is the only source with a live intake
 * step today; the rest can be tagged for future wiring without touching this
 * file. Which of these a given tenant actually sees is a further,
 * credential-configured intersection — see `resolveAvailableBriefSources`.
 */
export const BRIEF_SOURCE_CATALOG: readonly {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  /** The source's fetch tool name, when it has one wired
   * (`CredentialProviderCatalogEntry.briefSource.tool`) — the heartbeat
   * workflow generates an intake step only for entries that carry this. */
  tool?: string;
}[] = CREDENTIAL_PROVIDER_CATALOG.filter(
  (
    entry,
  ): entry is typeof entry & {
    briefSource: NonNullable<typeof entry.briefSource>;
  } => entry.briefSource !== undefined,
).map((entry) => ({
  key: entry.providerName,
  label: entry.label,
  description: entry.briefSource.description,
  defaultEnabled: entry.briefSource.defaultEnabled ?? false,
  ...(entry.briefSource.tool !== undefined
    ? { tool: entry.briefSource.tool }
    : {}),
}));

/**
 * The subset of `BRIEF_SOURCE_CATALOG` with a wired fetch tool — what the
 * heartbeat workflow (`workflows/heartbeat/src/index.ts`) generates one
 * intake `deterministicToolStep` per entry from. Exported so the workflow
 * and its tests share the same derivation rather than re-filtering the
 * catalog inline.
 */
/** The heartbeat intake step key generated for a wired brief source. */
export function heartbeatIntakeStepKey(sourceKey: string): string {
  return `intake-${sourceKey}`;
}

export const WIRED_BRIEF_SOURCES: readonly ((typeof BRIEF_SOURCE_CATALOG)[number] & {
  tool: string;
})[] = BRIEF_SOURCE_CATALOG.filter(
  (
    source,
  ): source is (typeof BRIEF_SOURCE_CATALOG)[number] & { tool: string } =>
    source.tool !== undefined,
);

/** The registry key a brief source's enablement toggle is stored under. */
export function briefSourcePreferenceKey(sourceKey: string): string {
  return `briefSource:${sourceKey}`;
}

/**
 * The brief-source fetch contract every source's intake tool shares —
 * formalizes the shape `granola_list_notes` pioneered (see
 * `@workbench/tools-granola`) so a new source's fetch tool and the heartbeat
 * workflow validate against one definition instead of each re-deriving it.
 *
 * `enabledSources` is the member's currently-enabled brief source keys
 * (`BRIEF_SOURCE_CATALOG` keys, i.e. `CredentialProviderCatalogEntry.providerName`).
 * Absent means "no restriction" — call as normal; an explicit list that
 * omits this source's key means self-skip (see
 * `BriefSourceSkippedMarkerSchema`) instead of calling out.
 *
 * `createdAfter` is the heartbeat's fire-time lookback cutoff, stamped by
 * `enrichHeartbeatTriggerPayload` (`apps/hub/src/lib/heartbeat-trigger-payload.ts`)
 * onto the trigger payload every intake step reads from.
 */
export const BriefSourceFetchInputSchema = type({
  "enabledSources?": "string[]",
  "createdAfter?": "string",
});
export type BriefSourceFetchInput = typeof BriefSourceFetchInputSchema.infer;

/**
 * The marker a brief-source fetch tool returns instead of calling out, when
 * `enabledSources` is set and omits this source's key, or (for a
 * heartbeat-shaped call, i.e. `enabledSources !== undefined`) the source's
 * credential is missing or rejected. Read by the synthesis prompt to
 * describe the source as honestly disabled/unavailable rather than a failed
 * fetch — never as an error.
 */
export const BriefSourceSkippedMarkerSchema = type({
  skipped: "true",
});
export type BriefSourceSkippedMarker =
  typeof BriefSourceSkippedMarkerSchema.infer;

/** The skip marker value every brief-source fetch tool returns verbatim on
 * self-skip, kept in one place so a source's `SKIPPED_LIST_RESULT` and this
 * contract cannot drift on the literal shape. */
export const BRIEF_SOURCE_SKIPPED_MARKER: BriefSourceSkippedMarker = {
  skipped: true,
};

/**
 * Whether a brief source should be called, given the caller's
 * `enabledSources`. Shared by every source's fetch tool so the self-skip
 * check (`isHeartbeatShaped` + membership test in `@workbench/tools-granola`)
 * is one function, not one per source.
 */
export function isBriefSourceFetchEnabled(
  sourceKey: string,
  enabledSources: string[] | undefined,
): boolean {
  return enabledSources === undefined || enabledSources.includes(sourceKey);
}

const BRIEF_SOURCE_ENTRIES: readonly PreferenceEntry[] =
  BRIEF_SOURCE_CATALOG.map((source) => ({
    key: briefSourcePreferenceKey(source.key),
    type: "boolean",
    default: source.defaultEnabled,
    label: source.label,
    description: source.description,
    category: "Automations",
  }));

export const PREFERENCE_REGISTRY: readonly PreferenceEntry[] = [
  ...PREFERENCE_REGISTRY_BASE,
  ...BRIEF_SOURCE_ENTRIES,
];

const registryByKey = new Map(PREFERENCE_REGISTRY.map((e) => [e.key, e]));

export function getPreferenceEntry(key: string): PreferenceEntry | undefined {
  return registryByKey.get(key);
}

export const PREFERENCE_KEYS: readonly string[] = PREFERENCE_REGISTRY.map(
  (e) => e.key,
);

export const PREFERENCE_DEFAULTS: Readonly<
  Record<string, boolean | string | number>
> = Object.fromEntries(PREFERENCE_REGISTRY.map((e) => [e.key, e.default]));

const hourUtcSchema = type("0 <= number.integer <= 23");
const booleanSchema = type("boolean");

/** The arktype validator for a single entry's value, derived from its type. */
export function preferenceValueSchema(entry: PreferenceEntry) {
  if (entry.type === "boolean") return booleanSchema;
  if (entry.type === "hourUtc") return hourUtcSchema;
  return type.enumerated(...(entry.options ?? []).map((o) => o.value));
}

/**
 * Keys the write path accepts that are NOT registry-managed — they are owned by
 * the `@workbench/ui` preference store (appearance) or written by workflows
 * (Attio member, favorites). Kept in lockstep with the explicit fields of the
 * `MemberPreferences` schema, plus the legacy keys that ride its index
 * signature (per-page view-mode toggles), so the registry can reject
 * genuinely unknown keys without breaking those subsystems.
 *
 * `changelogSeenVersion` rides this list rather than the registry proper: it
 * is a stamped version string (not a boolean/select/hourUtc control), and it
 * must never render as an editable row on the Settings page — the "what's
 * new" pop-up and dialog are its only writers.
 */
export const NON_REGISTRY_PREFERENCE_KEYS = [
  "theme",
  "compactToolActivity",
  "toolSummaryStyle",
  "experimentalArtifactCards",
  "attioMemberId",
  "favoriteWorkflows",
  "artifactsViewMode",
  "toolsViewMode",
  "skillsViewMode",
  "changelogSeenVersion",
] as const;

function isNonRegistryKey(key: string): boolean {
  return (NON_REGISTRY_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * Validates a preferences patch against the registry: every registry-managed
 * key must carry a value of its declared type, and any key that is neither a
 * registry key nor a known non-registry key is rejected. Returns an error
 * message on the first offending key, or `null` when the patch is acceptable.
 */
export function validatePreferencePatch(
  patch: Record<string, unknown>,
): string | null {
  for (const [key, value] of Object.entries(patch)) {
    const entry = registryByKey.get(key);
    if (entry) {
      const parsed = preferenceValueSchema(entry)(value);
      if (parsed instanceof type.errors) {
        return `${key}: ${parsed.summary}`;
      }
      continue;
    }
    if (!isNonRegistryKey(key)) {
      return `Unknown preference key: ${key}`;
    }
  }
  return null;
}

export const PreferenceSettingSchema = type({
  key: "string",
  type: "'boolean' | 'select' | 'hourUtc'",
  default: "boolean | string | number",
  label: "string",
  description: "string",
  category: PreferenceCategorySchema,
  "options?": PreferenceOptionSchema.array(),
  value: "boolean | string | number",
});
export type PreferenceSetting = typeof PreferenceSettingSchema.infer;

export const PreferenceSettingsResponseSchema = type({
  settings: PreferenceSettingSchema.array(),
});
export type PreferenceSettingsResponse =
  typeof PreferenceSettingsResponseSchema.infer;

function resolveValue(
  entry: PreferenceEntry,
  stored: unknown,
): boolean | string | number {
  const parsed = preferenceValueSchema(entry)(stored);
  if (parsed instanceof type.errors) return entry.default;
  if (entry.type === "boolean" && typeof parsed === "boolean") return parsed;
  if (entry.type === "hourUtc" && typeof parsed === "number") return parsed;
  if (entry.type === "select" && typeof parsed === "string") return parsed;
  return entry.default;
}

/**
 * Projects the registry against a member's stored preferences, resolving each
 * entry to its stored value when present and valid, otherwise its default. This
 * is the shape the settings surface renders from.
 */
export function resolvePreferenceSettings(
  stored: Record<string, unknown>,
): PreferenceSetting[] {
  return PREFERENCE_REGISTRY.map((entry) => ({
    ...entry,
    value: resolveValue(entry, stored[entry.key]),
  }));
}

/**
 * Resolves the member's currently-enabled brief source keys (e.g.
 * `["granola"]`) against their stored preferences, defaulting each source to
 * its catalog default when unset. This is what the hub scheduler reads at
 * heartbeat fire time, and what the workflow's trigger payload carries so an
 * intake step can skip a disabled source honestly instead of calling it.
 */
export function resolveEnabledBriefSources(
  stored: Record<string, unknown>,
): string[] {
  return BRIEF_SOURCE_CATALOG.filter((source) => {
    const entry = registryByKey.get(briefSourcePreferenceKey(source.key));
    if (!entry) return source.defaultEnabled;
    return resolveValue(entry, stored[entry.key]) === true;
  }).map((source) => source.key);
}

/** One brief source the caller's tenant can actually toggle: catalog copy
 * plus their currently-resolved enablement. Never emitted for a source whose
 * provider has no credential configured for the tenant — the hub route
 * filters `BRIEF_SOURCE_CATALOG` down to `availableProviderNames` before
 * calling this, so an unconfigured source is silently absent, never shown
 * disabled-with-reason. */
export const AvailableBriefSourceSchema = type({
  key: "string",
  label: "string",
  description: "string",
  enabled: "boolean",
});
export type AvailableBriefSource = typeof AvailableBriefSourceSchema.infer;

export const AvailableBriefSourcesResponseSchema = type({
  sources: AvailableBriefSourceSchema.array(),
});
export type AvailableBriefSourcesResponse =
  typeof AvailableBriefSourcesResponseSchema.infer;

/**
 * Projects `BRIEF_SOURCE_CATALOG` down to the sources the tenant has a
 * configured credential for (`availableProviderNames`, computed by the hub
 * via the same `resolveCredentialRequirement` the launch/tool-gallery paths
 * use), each resolved against the member's stored preference. This is what
 * the composer renders: a source is either fully present with a working
 * toggle, or entirely absent — never present-but-broken.
 */
export function resolveAvailableBriefSources(
  availableProviderNames: readonly string[],
  stored: Record<string, unknown>,
): AvailableBriefSource[] {
  const available = new Set(availableProviderNames);
  return BRIEF_SOURCE_CATALOG.filter((source) => available.has(source.key)).map(
    (source) => {
      const entry = registryByKey.get(briefSourcePreferenceKey(source.key));
      const enabled = entry
        ? resolveValue(entry, stored[entry.key]) === true
        : source.defaultEnabled;
      return {
        key: source.key,
        label: source.label,
        description: source.description,
        enabled,
      };
    },
  );
}
