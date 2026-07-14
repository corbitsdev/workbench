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
  WIRED_BRIEF_SOURCES,
  briefSourcePreferenceKey,
  resolveEnabledBriefSources,
  resolveAvailableBriefSources,
  AvailableBriefSourceSchema,
  BriefSourceFetchInputSchema,
  BriefSourceSkippedMarkerSchema,
  BRIEF_SOURCE_SKIPPED_MARKER,
  isBriefSourceFetchEnabled,
  INBOX_SOURCE_CATALOG,
  inboxSourcePreferenceKey,
  resolveEnabledInboxSources,
  resolveAvailableInboxSources,
  AvailableInboxSourceSchema,
  AvailabilitySignalSchema,
  LINEAR_SCOPE_PREFERENCE_KEY,
  LINEAR_BACKFILL_PREFERENCE_KEY,
} from "./preferences-registry";
import { CREDENTIAL_PROVIDER_CATALOG } from "./governance";

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

  test("briefHourUtc and the heartbeat-fed notify* fields gate on heartbeat deployment", () => {
    for (const key of ["briefHourUtc", "notifyInboxMail", "notifyGateAsks"]) {
      const entry = getPreferenceEntry(key);
      expect(entry?.availableWhen).toEqual({
        kind: "workflow-deployed",
        workflowKind: "heartbeat",
      });
    }
  });

  test("tasksAutoSendAdapter gates on the attio connection", () => {
    const entry = getPreferenceEntry("tasksAutoSendAdapter");
    expect(entry?.availableWhen).toEqual({
      kind: "credential-connected",
      provider: "attio",
    });
  });

  test("agentAutonomy has no availability signal (no capability projection wired yet)", () => {
    const entry = getPreferenceEntry("agentAutonomy");
    expect(entry?.availableWhen).toBeUndefined();
  });

  test("AvailabilitySignalSchema accepts all three signal kinds and rejects an unknown kind", () => {
    expect(
      AvailabilitySignalSchema({
        kind: "workflow-deployed",
        workflowKind: "heartbeat",
      }) instanceof type.errors,
    ).toBe(false);
    expect(
      AvailabilitySignalSchema({
        kind: "capability",
        provider: "attio",
      }) instanceof type.errors,
    ).toBe(false);
    expect(
      AvailabilitySignalSchema({
        kind: "credential-connected",
        provider: "attio",
      }) instanceof type.errors,
    ).toBe(false);
    expect(
      AvailabilitySignalSchema({ kind: "bogus", provider: "attio" }) instanceof
        type.errors,
    ).toBe(true);
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

  test("registers the tasks toggles with defaults that keep current behavior", () => {
    const triageCreate = getPreferenceEntry("tasksTriageCreate");
    expect(triageCreate?.type).toBe("boolean");
    expect(triageCreate?.category).toBe("Automations");
    expect(triageCreate?.default).toBe(true);

    // Task-event mail is a single preference owned by the delivery seam.
    expect(getPreferenceEntry("tasksNotifyMail")).toBeUndefined();
    const taskMail = getPreferenceEntry("taskMailEnabled");
    expect(taskMail?.default).toBe(true);

    const autoSend = getPreferenceEntry("tasksAutoSendAdapter");
    expect(autoSend?.type).toBe("boolean");
    expect(autoSend?.category).toBe("Automations");
    expect(autoSend?.default).toBe(false);

    const showCompleted = getPreferenceEntry("tasksShowCompleted");
    expect(showCompleted?.type).toBe("boolean");
    expect(showCompleted?.category).toBe("Inbox");
    expect(showCompleted?.default).toBe(false);
  });

  test("PREFERENCE_DEFAULTS mirrors the registry defaults", () => {
    for (const entry of PREFERENCE_REGISTRY) {
      expect(PREFERENCE_DEFAULTS[entry.key]).toBe(entry.default);
    }
  });

  test("registers a boolean toggle for every brief source, defaulting off", () => {
    for (const source of BRIEF_SOURCE_CATALOG) {
      const entry = getPreferenceEntry(briefSourcePreferenceKey(source.key));
      expect(entry?.type).toBe("boolean");
      expect(entry?.category).toBe("Automations");
      expect(entry?.default).toBe(false);
      expect(source.defaultEnabled).toBe(false);
    }
  });

  test("registers a boolean toggle for every inbox source, defaulting off", () => {
    for (const source of INBOX_SOURCE_CATALOG) {
      const entry = getPreferenceEntry(inboxSourcePreferenceKey(source.key));
      expect(entry?.type).toBe("boolean");
      expect(entry?.category).toBe("Inbox");
      expect(entry?.default).toBe(false);
      expect(source.defaultEnabled).toBe(false);
    }
  });

  test("registers the Linear scope option defaulting to assigned (CL-3577)", () => {
    const entry = getPreferenceEntry(LINEAR_SCOPE_PREFERENCE_KEY);
    expect(entry?.type).toBe("select");
    expect(entry?.category).toBe("Inbox");
    expect(entry?.default).toBe("assigned");
    expect(entry?.options?.map((o) => o.value).sort()).toEqual([
      "all",
      "assigned",
    ]);
  });

  test("registers the Linear backfill option defaulting to none (CL-3577)", () => {
    const entry = getPreferenceEntry(LINEAR_BACKFILL_PREFERENCE_KEY);
    expect(entry?.type).toBe("select");
    expect(entry?.category).toBe("Inbox");
    expect(entry?.default).toBe("none");
    expect(entry?.options?.map((o) => o.value).sort()).toEqual([
      "30d",
      "7d",
      "none",
    ]);
  });

  test("no brief or inbox source defaults enabled (CL-3577)", () => {
    for (const source of BRIEF_SOURCE_CATALOG) {
      expect(source.defaultEnabled).toBe(false);
    }
    for (const source of INBOX_SOURCE_CATALOG) {
      expect(source.defaultEnabled).toBe(false);
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

describe("BRIEF_SOURCE_CATALOG", () => {
  test("is derived from every CREDENTIAL_PROVIDER_CATALOG entry tagged briefSource", () => {
    const tagged = CREDENTIAL_PROVIDER_CATALOG.filter(
      (e) => e.briefSource !== undefined,
    );
    expect(BRIEF_SOURCE_CATALOG.length).toBe(tagged.length);
    expect(BRIEF_SOURCE_CATALOG.map((s) => s.key).sort()).toEqual(
      tagged.map((e) => e.providerName).sort(),
    );
  });

  test("includes granola", () => {
    expect(BRIEF_SOURCE_CATALOG.some((s) => s.key === "granola")).toBe(true);
  });
});

describe("resolveAvailableBriefSources", () => {
  test("excludes a catalog source with no configured credential", () => {
    const sources = resolveAvailableBriefSources([], {});
    expect(sources).toEqual([]);
  });

  test("includes a catalog source whose credential is configured", () => {
    const sources = resolveAvailableBriefSources(["granola"], {});
    expect(sources.map((s) => s.key)).toEqual(["granola"]);
    for (const source of sources) {
      const parsed = AvailableBriefSourceSchema(source);
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("a catalog addition appears once its provider is configured, with no other change", () => {
    const beforeAll = resolveAvailableBriefSources(
      CREDENTIAL_PROVIDER_CATALOG.map((e) => e.providerName),
      {},
    );
    expect(beforeAll.length).toBe(BRIEF_SOURCE_CATALOG.length);
  });

  test("resolves enabled from stored preferences, defaulting per catalog entry", () => {
    const disabledByDefault = resolveAvailableBriefSources(["granola"], {});
    expect(disabledByDefault[0]?.enabled).toBe(false);

    const enabled = resolveAvailableBriefSources(["granola"], {
      [briefSourcePreferenceKey("granola")]: true,
    });
    expect(enabled[0]?.enabled).toBe(true);
  });

  test("ignores a configured provider name absent from the brief-source catalog", () => {
    const sources = resolveAvailableBriefSources(["not-a-brief-source"], {});
    expect(sources).toEqual([]);
  });
});

describe("INBOX_SOURCE_CATALOG", () => {
  test("includes every BRIEF_SOURCE_CATALOG key plus inbox-only sources, defaulting every source off", () => {
    const inboxKeys = INBOX_SOURCE_CATALOG.map((s) => s.key);
    for (const key of BRIEF_SOURCE_CATALOG.map((s) => s.key)) {
      expect(inboxKeys).toContain(key);
    }
    for (const source of INBOX_SOURCE_CATALOG) {
      expect(source.defaultEnabled).toBe(false);
    }
  });

  test("includes slack, an inbox-only source with no brief-source equivalent (CL-3581)", () => {
    expect(BRIEF_SOURCE_CATALOG.map((s) => s.key)).not.toContain("slack");
    const slack = INBOX_SOURCE_CATALOG.find((s) => s.key === "slack");
    expect(slack?.description).toBe(
      "Slack mentions of you land in your inbox.",
    );
  });
});

describe("resolveEnabledInboxSources", () => {
  test("defaults to no sources enabled when nothing is stored (CL-3577)", () => {
    expect(resolveEnabledInboxSources({})).toEqual([]);
  });

  test("includes a source explicitly enabled in stored preferences", () => {
    const enabled = resolveEnabledInboxSources({
      [inboxSourcePreferenceKey("granola")]: true,
    });
    expect(enabled).toContain("granola");
  });

  test("toggling the inbox source on does not affect the brief source's enablement", () => {
    const stored = {
      [inboxSourcePreferenceKey("granola")]: true,
      [briefSourcePreferenceKey("granola")]: false,
    };
    expect(resolveEnabledInboxSources(stored)).toContain("granola");
    expect(resolveEnabledBriefSources(stored)).not.toContain("granola");
  });
});

describe("INBOX_SOURCE_CATALOG inbox-specific copy (CL-3577)", () => {
  test("linear, attio, and granola carry inbox-specific descriptions distinct from their brief copy", () => {
    for (const key of ["linear", "attio", "granola"]) {
      const inbox = INBOX_SOURCE_CATALOG.find((s) => s.key === key);
      const brief = BRIEF_SOURCE_CATALOG.find((s) => s.key === key);
      expect(inbox?.description).toBeDefined();
      expect(inbox?.description).not.toBe(brief?.description);
    }
  });

  test("linear's inbox description matches the CL-3577 spec copy", () => {
    const linear = INBOX_SOURCE_CATALOG.find((s) => s.key === "linear");
    expect(linear?.description).toBe(
      "New Linear activity assigned to you lands in your inbox.",
    );
  });
});

describe("resolveAvailableInboxSources", () => {
  test("excludes a catalog source with no configured credential", () => {
    expect(resolveAvailableInboxSources([], {})).toEqual([]);
  });

  test("includes a catalog source whose credential is configured, disabled by default (CL-3577)", () => {
    const sources = resolveAvailableInboxSources(["granola"], {});
    expect(sources.map((s) => s.key)).toEqual(["granola"]);
    expect(sources[0]?.enabled).toBe(false);
    for (const source of sources) {
      const parsed = AvailableInboxSourceSchema(source);
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("resolves a stored enablement", () => {
    const enabled = resolveAvailableInboxSources(["granola"], {
      [inboxSourcePreferenceKey("granola")]: true,
    });
    expect(enabled[0]?.enabled).toBe(true);
  });

  test("ignores a configured provider name absent from the inbox-source catalog", () => {
    const sources = resolveAvailableInboxSources(["not-a-source"], {});
    expect(sources).toEqual([]);
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

  test("accepts valid Linear scope/backfill values and rejects invalid ones", () => {
    expect(
      validatePreferencePatch({ [LINEAR_SCOPE_PREFERENCE_KEY]: "all" }),
    ).toBeNull();
    expect(
      validatePreferencePatch({ [LINEAR_BACKFILL_PREFERENCE_KEY]: "7d" }),
    ).toBeNull();
    expect(
      validatePreferencePatch({ [LINEAR_SCOPE_PREFERENCE_KEY]: "bogus" }),
    ).not.toBeNull();
    expect(
      validatePreferencePatch({ [LINEAR_BACKFILL_PREFERENCE_KEY]: "60d" }),
    ).not.toBeNull();
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

  test("accepts onboarding.welcomeSentAt without a registry entry", () => {
    expect(getPreferenceEntry("onboarding.welcomeSentAt")).toBeUndefined();
    expect(
      validatePreferencePatch({
        "onboarding.welcomeSentAt": "2026-07-12T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("changelogSeenVersion", () => {
  test("is excluded from resolvePreferenceSettings so it never renders as a control", () => {
    const settings = resolvePreferenceSettings({
      changelogSeenVersion: "0.6.0",
    });
    expect(
      settings.find((s) => s.key === "changelogSeenVersion"),
    ).toBeUndefined();
  });
});

describe("onboarding.welcomeSentAt", () => {
  test("is excluded from resolvePreferenceSettings so it never renders as a control", () => {
    const settings = resolvePreferenceSettings({
      "onboarding.welcomeSentAt": "2026-07-12T00:00:00.000Z",
    });
    expect(
      settings.find((s) => s.key === "onboarding.welcomeSentAt"),
    ).toBeUndefined();
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

describe("brief-source fetch contract", () => {
  test("BriefSourceFetchInputSchema accepts enabledSources + createdAfter, both optional", () => {
    expect(
      BriefSourceFetchInputSchema({
        enabledSources: ["granola"],
        createdAfter: "2026-07-04T00:00:00Z",
      }) instanceof type.errors,
    ).toBe(false);
    expect(BriefSourceFetchInputSchema({}) instanceof type.errors).toBe(false);
  });

  test("BriefSourceFetchInputSchema rejects a non-array enabledSources", () => {
    expect(
      BriefSourceFetchInputSchema({ enabledSources: "granola" }) instanceof
        type.errors,
    ).toBe(true);
  });

  test("BriefSourceSkippedMarkerSchema only accepts skipped: true", () => {
    expect(
      BriefSourceSkippedMarkerSchema({ skipped: true }) instanceof type.errors,
    ).toBe(false);
    expect(
      BriefSourceSkippedMarkerSchema({ skipped: false }) instanceof type.errors,
    ).toBe(true);
  });

  test("BRIEF_SOURCE_SKIPPED_MARKER satisfies its own schema", () => {
    expect(
      BriefSourceSkippedMarkerSchema(BRIEF_SOURCE_SKIPPED_MARKER) instanceof
        type.errors,
    ).toBe(false);
  });

  test("isBriefSourceFetchEnabled: undefined enabledSources means no restriction", () => {
    expect(isBriefSourceFetchEnabled("granola", undefined)).toBe(true);
  });

  test("isBriefSourceFetchEnabled: true only when the source key is present", () => {
    expect(isBriefSourceFetchEnabled("granola", ["granola", "linear"])).toBe(
      true,
    );
    expect(isBriefSourceFetchEnabled("granola", ["linear"])).toBe(false);
    expect(isBriefSourceFetchEnabled("granola", [])).toBe(false);
  });
});

describe("WIRED_BRIEF_SOURCES", () => {
  test("is the subset of BRIEF_SOURCE_CATALOG with a tool", () => {
    expect(WIRED_BRIEF_SOURCES.every((s) => typeof s.tool === "string")).toBe(
      true,
    );
    expect(WIRED_BRIEF_SOURCES.length).toBe(
      BRIEF_SOURCE_CATALOG.filter((s) => s.tool !== undefined).length,
    );
  });

  test("includes granola with its granola_list_notes tool today", () => {
    const granola = WIRED_BRIEF_SOURCES.find((s) => s.key === "granola");
    expect(granola?.tool).toBe("granola_list_notes");
  });
});
