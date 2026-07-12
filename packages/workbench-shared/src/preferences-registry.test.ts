import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  PREFERENCE_REGISTRY,
  PREFERENCE_DEFAULTS,
  PreferenceEntrySchema,
  getPreferenceEntry,
  preferenceValueSchema,
  validatePreferencePatch,
  resolvePreferenceSettings,
  BRIEF_SOURCE_CATALOG,
  briefSourcePreferenceKey,
  resolveEnabledBriefSources,
} from "./preferences-registry";

describe("PREFERENCE_REGISTRY", () => {
  test("every entry validates against the entry schema", () => {
    for (const entry of PREFERENCE_REGISTRY) {
      const parsed = PreferenceEntrySchema(entry);
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("keys are unique", () => {
    const keys = PREFERENCE_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("select entries carry options; non-select entries do not", () => {
    for (const entry of PREFERENCE_REGISTRY) {
      if (entry.type === "select") {
        expect((entry.options ?? []).length).toBeGreaterThan(0);
      } else {
        expect(entry.options).toBeUndefined();
      }
    }
  });

  test("every default is a valid value for its entry", () => {
    for (const entry of PREFERENCE_REGISTRY) {
      const parsed = preferenceValueSchema(entry)(entry.default);
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("registers agentAutonomy with the pinned contract", () => {
    const entry = getPreferenceEntry("agentAutonomy");
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("select");
    expect(entry?.category).toBe("Agent");
    expect(entry?.default).toBe("prepare_only");
    expect(entry?.options?.map((o) => o.value)).toEqual([
      "prepare_only",
      "execute_with_gates",
    ]);
  });

  test("registers briefHourUtc defaulting to 13 in Automations", () => {
    const entry = getPreferenceEntry("briefHourUtc");
    expect(entry?.type).toBe("hourUtc");
    expect(entry?.category).toBe("Automations");
    expect(entry?.default).toBe(13);
  });

  test("registers the notification toggles defaulting on", () => {
    for (const key of ["notifyInboxMail", "notifyGateAsks"]) {
      const entry = getPreferenceEntry(key);
      expect(entry?.type).toBe("boolean");
      expect(entry?.category).toBe("Notifications");
      expect(entry?.default).toBe(true);
    }
  });

  test("PREFERENCE_DEFAULTS mirrors the registry defaults", () => {
    for (const entry of PREFERENCE_REGISTRY) {
      expect(PREFERENCE_DEFAULTS[entry.key]).toBe(entry.default);
    }
  });

  test("registers a boolean toggle for every brief source, defaulting on", () => {
    for (const source of BRIEF_SOURCE_CATALOG) {
      const entry = getPreferenceEntry(briefSourcePreferenceKey(source.key));
      expect(entry?.type).toBe("boolean");
      expect(entry?.category).toBe("Automations");
      expect(entry?.default).toBe(source.defaultEnabled);
    }
  });
});

describe("resolveEnabledBriefSources", () => {
  test("defaults to every catalog source's default when nothing is stored", () => {
    expect(resolveEnabledBriefSources({})).toEqual(
      BRIEF_SOURCE_CATALOG.filter((s) => s.defaultEnabled).map((s) => s.key),
    );
  });

  test("excludes a source explicitly disabled in stored preferences", () => {
    const enabled = resolveEnabledBriefSources({
      [briefSourcePreferenceKey("granola")]: false,
    });
    expect(enabled).not.toContain("granola");
  });

  test("includes a source explicitly re-enabled in stored preferences", () => {
    const enabled = resolveEnabledBriefSources({
      [briefSourcePreferenceKey("granola")]: true,
    });
    expect(enabled).toContain("granola");
  });
});

describe("preferenceValueSchema", () => {
  test("boolean accepts booleans and rejects other types", () => {
    const schema = preferenceValueSchema(
      getPreferenceEntry("notifyInboxMail")!,
    );
    expect(schema(true) instanceof type.errors).toBe(false);
    expect(schema("true") instanceof type.errors).toBe(true);
  });

  test("hourUtc accepts integers 0..23 and rejects out-of-range or fractional", () => {
    const schema = preferenceValueSchema(getPreferenceEntry("briefHourUtc")!);
    expect(schema(0) instanceof type.errors).toBe(false);
    expect(schema(23) instanceof type.errors).toBe(false);
    expect(schema(24) instanceof type.errors).toBe(true);
    expect(schema(-1) instanceof type.errors).toBe(true);
    expect(schema(13.5) instanceof type.errors).toBe(true);
    expect(schema("13") instanceof type.errors).toBe(true);
  });

  test("select accepts an option value and rejects an unknown value", () => {
    const schema = preferenceValueSchema(getPreferenceEntry("agentAutonomy")!);
    expect(schema("execute_with_gates") instanceof type.errors).toBe(false);
    expect(schema("yolo") instanceof type.errors).toBe(true);
  });
});

describe("validatePreferencePatch", () => {
  test("accepts a valid registry value", () => {
    expect(
      validatePreferencePatch({ agentAutonomy: "execute_with_gates" }),
    ).toBeNull();
  });

  test("rejects a wrong-typed registry value", () => {
    expect(validatePreferencePatch({ briefHourUtc: 99 })).not.toBeNull();
    expect(validatePreferencePatch({ notifyGateAsks: "yes" })).not.toBeNull();
  });

  test("rejects an unknown key", () => {
    expect(validatePreferencePatch({ bogusSetting: true })).not.toBeNull();
  });

  test("accepts legacy non-registry keys owned by other subsystems", () => {
    expect(validatePreferencePatch({ theme: "notion" })).toBeNull();
    expect(validatePreferencePatch({ favoriteWorkflows: ["a"] })).toBeNull();
  });

  test("accepts legacy per-page view-mode keys riding the index signature", () => {
    expect(
      validatePreferencePatch({
        artifactsViewMode: "rows",
        toolsViewMode: "grid",
        skillsViewMode: "rows",
      }),
    ).toBeNull();
  });

  test("accepts changelogSeenVersion without a registry entry", () => {
    expect(getPreferenceEntry("changelogSeenVersion")).toBeUndefined();
    expect(
      validatePreferencePatch({ changelogSeenVersion: "0.6.0" }),
    ).toBeNull();
  });
});

describe("changelogSeenVersion", () => {
  test("is excluded from resolvePreferenceSettings so it never renders as a control", () => {
    const settings = resolvePreferenceSettings({ changelogSeenVersion: "0.6.0" });
    expect(settings.find((s) => s.key === "changelogSeenVersion")).toBeUndefined();
  });
});

describe("resolvePreferenceSettings", () => {
  test("uses the default when a value is unset", () => {
    const settings = resolvePreferenceSettings({});
    const autonomy = settings.find((s) => s.key === "agentAutonomy");
    expect(autonomy?.value).toBe("prepare_only");
  });

  test("uses the stored value when set and valid", () => {
    const settings = resolvePreferenceSettings({ briefHourUtc: 9 });
    expect(settings.find((s) => s.key === "briefHourUtc")?.value).toBe(9);
  });

  test("falls back to the default when the stored value is invalid", () => {
    const settings = resolvePreferenceSettings({ briefHourUtc: 99 });
    expect(settings.find((s) => s.key === "briefHourUtc")?.value).toBe(13);
  });

  test("returns one resolved setting per registry entry", () => {
    expect(resolvePreferenceSettings({}).length).toBe(
      PREFERENCE_REGISTRY.length,
    );
  });
});
