import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  PREFERENCE_KEYS,
  getPreferenceRaw,
  hydratePreference,
  hydrateServerPreferences,
  serverPatchForRawChange,
  setPreference,
  setPreferencePersister,
  usePreferenceRaw,
  viewModeServerKey,
  viewModeStorageKey,
} from "./preferences-store";
import { act, renderHook } from "@testing-library/react";

beforeEach(() => {
  localStorage.clear();
  setPreferencePersister(null);
});

afterEach(() => {
  localStorage.clear();
  setPreferencePersister(null);
});

describe("setPreference", () => {
  it("writes localStorage and notifies the injected persister", () => {
    const persist = mock((_k: string, _v: string) => {});
    setPreferencePersister(persist);
    setPreference("cw-theme", "tkww");
    expect(getPreferenceRaw("cw-theme")).toBe("tkww");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]).toEqual(["cw-theme", "tkww"]);
  });
});

describe("hydratePreference", () => {
  it("writes a server value without invoking the persister (no echo)", () => {
    const persist = mock((_k: string, _v: string) => {});
    setPreferencePersister(persist);
    hydratePreference("cw-theme", "notion");
    expect(getPreferenceRaw("cw-theme")).toBe("notion");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("hydrateServerPreferences", () => {
  it("maps each known server key to its stored raw form", () => {
    hydrateServerPreferences({
      theme: "notion",
      compactToolActivity: true,
      toolSummaryStyle: "mixed",
      experimentalArtifactCards: true,
    });
    expect(getPreferenceRaw(PREFERENCE_KEYS.theme)).toBe("notion");
    expect(getPreferenceRaw(PREFERENCE_KEYS.compactToolActivity)).toBe("true");
    expect(getPreferenceRaw(PREFERENCE_KEYS.toolSummaryStyle)).toBe("mixed");
    expect(getPreferenceRaw(PREFERENCE_KEYS.experimentalArtifactCards)).toBe(
      "true",
    );
  });

  it("ignores keys with the wrong type", () => {
    hydrateServerPreferences({ compactToolActivity: "yes" });
    expect(getPreferenceRaw(PREFERENCE_KEYS.compactToolActivity)).toBeNull();
  });
});

describe("per-key subscriptions", () => {
  it("a write to one key does not re-render a reader of a different key", () => {
    let themeRenders = 0;
    let compactRenders = 0;
    renderHook(() => {
      themeRenders += 1;
      return usePreferenceRaw(PREFERENCE_KEYS.theme);
    });
    renderHook(() => {
      compactRenders += 1;
      return usePreferenceRaw(PREFERENCE_KEYS.compactToolActivity);
    });
    const themeBefore = themeRenders;
    const compactBefore = compactRenders;
    act(() => setPreference(PREFERENCE_KEYS.theme, "tkww"));
    expect(themeRenders).toBeGreaterThan(themeBefore);
    expect(compactRenders).toBe(compactBefore);
  });
});

describe("serverPatchForRawChange", () => {
  it("coerces boolean flags back to booleans for the server patch", () => {
    expect(
      serverPatchForRawChange(PREFERENCE_KEYS.compactToolActivity, "true"),
    ).toEqual({
      compactToolActivity: true,
    });
    expect(
      serverPatchForRawChange(PREFERENCE_KEYS.compactToolActivity, "false"),
    ).toEqual({
      compactToolActivity: false,
    });
    expect(
      serverPatchForRawChange(
        PREFERENCE_KEYS.experimentalArtifactCards,
        "true",
      ),
    ).toEqual({
      experimentalArtifactCards: true,
    });
  });

  it("passes string-valued prefs through", () => {
    expect(serverPatchForRawChange(PREFERENCE_KEYS.theme, "tkww")).toEqual({
      theme: "tkww",
    });
  });

  it("returns null for an unmapped key", () => {
    expect(serverPatchForRawChange("cw-unknown", "x")).toBeNull();
  });

  it("maps a per-scope view-mode key to its server key", () => {
    expect(
      serverPatchForRawChange(viewModeStorageKey("tools"), "rows"),
    ).toEqual({ [viewModeServerKey("tools")]: "rows" });
  });
});

describe("view-mode hydration", () => {
  it("hydrates each scope's view-mode from the server blob", () => {
    hydrateServerPreferences({
      artifactsViewMode: "rows",
      toolsViewMode: "grid",
    });
    expect(getPreferenceRaw(viewModeStorageKey("artifacts"))).toBe("rows");
    expect(getPreferenceRaw(viewModeStorageKey("tools"))).toBe("grid");
    expect(getPreferenceRaw(viewModeStorageKey("skills"))).toBeNull();
  });

  it("ignores a non-string view-mode value", () => {
    hydrateServerPreferences({ skillsViewMode: 3 });
    expect(getPreferenceRaw(viewModeStorageKey("skills"))).toBeNull();
  });
});
