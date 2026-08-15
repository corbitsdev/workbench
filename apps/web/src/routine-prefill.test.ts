import { afterEach, describe, expect, test } from "bun:test";
import {
  consumePendingRoutinePrefill,
  resetPendingRoutinePrefill,
  setPendingRoutinePrefill,
} from "./routine-prefill";

describe("routine prefill", () => {
  afterEach(() => {
    resetPendingRoutinePrefill();
  });

  test("consuming returns null when nothing is pending", () => {
    expect(consumePendingRoutinePrefill()).toBe(null);
  });

  test("consuming returns what was set, then clears it", () => {
    const prefill = {
      definitionId: "wfd_1",
      name: "Summarize last night's incident",
      input: { prompt: "Summarize last night's incident." },
    };
    setPendingRoutinePrefill(prefill);

    expect(consumePendingRoutinePrefill()).toEqual(prefill);
    expect(consumePendingRoutinePrefill()).toBe(null);
  });

  test("reset drops a pending prefill without returning it", () => {
    setPendingRoutinePrefill({
      definitionId: "wfd_1",
      name: "Name",
      input: {},
    });
    resetPendingRoutinePrefill();

    expect(consumePendingRoutinePrefill()).toBe(null);
  });

  test("a space-only prefill (no catalog pick) round-trips just its deliveryChannelId", () => {
    setPendingRoutinePrefill({ deliveryChannelId: "ch_space1" });

    expect(consumePendingRoutinePrefill()).toEqual({
      deliveryChannelId: "ch_space1",
    });
  });
});
