import { type } from "arktype";

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
];

/**
 * Catalog of sources the morning brief can pull from. Adding a source is
 * purely additive here — a new catalog row and, when the source is wired
 * into an intake step, a check of `enabledSources` at that step. No registry
 * restructuring is needed. `granola` is the only source with a live intake
 * step today; the rest are declared for future wiring.
 */
export const BRIEF_SOURCE_CATALOG: readonly {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}[] = [
  {
    key: "granola",
    label: "Granola calls",
    description: "Pull in recent call notes from Granola.",
    defaultEnabled: true,
  },
];

/** The registry key a brief source's enablement toggle is stored under. */
export function briefSourcePreferenceKey(sourceKey: string): string {
  return `briefSource:${sourceKey}`;
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
