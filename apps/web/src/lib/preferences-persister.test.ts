import { afterEach, describe, expect, it, mock } from "bun:test";

const patchMePreferences = mock(
  async (_patch: Record<string, unknown>) => ({}),
);
mock.module("./hub-api", () => ({ patchMePreferences }));

import { createPreferencesPersister } from "./preferences-persister";

afterEach(() => {
  patchMePreferences.mockClear();
});

describe("createPreferencesPersister", () => {
  it("coalesces multiple raw changes into one mapped server patch on flush", () => {
    const { persist, flush } = createPreferencesPersister();
    persist("cw-theme", "tkww");
    persist("cw-compact-tools", "true");
    persist("cw-tool-summary-style", "mixed");
    flush();
    expect(patchMePreferences).toHaveBeenCalledTimes(1);
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      theme: "tkww",
      compactToolActivity: true,
      toolSummaryStyle: "mixed",
    });
  });

  it("lets a later change for the same key win", () => {
    const { persist, flush } = createPreferencesPersister();
    persist("cw-compact-tools", "true");
    persist("cw-compact-tools", "false");
    flush();
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      compactToolActivity: false,
    });
  });

  it("ignores keys with no server mapping", () => {
    const { persist, flush } = createPreferencesPersister();
    persist("cw-unmapped", "x");
    flush();
    expect(patchMePreferences).not.toHaveBeenCalled();
  });

  it("does not sync local-only Myra voice preference to the server", () => {
    const { persist, flush } = createPreferencesPersister();
    persist("cw-myra-voice", "false");
    flush();
    expect(patchMePreferences).not.toHaveBeenCalled();
  });

  it("does not fire a request when nothing is pending", () => {
    const { flush } = createPreferencesPersister();
    flush();
    expect(patchMePreferences).not.toHaveBeenCalled();
  });
});
