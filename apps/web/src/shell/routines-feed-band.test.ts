// Pure-function proof for the Routines panel's filter-chip re-pick logic —
// no fetch, no DOM. Mirrors the shell mock's `rtf-*` chip handler: a filter
// change keeps the current selection when it still matches, otherwise picks
// the first matching routine, otherwise falls back to the bare list.

import { describe, expect, test } from "bun:test";

import { nextRoutinePathForFilter } from "./routines-feed-band";
import type { Routine } from "../routines-api";

function routine(id: string, trigger: Routine["trigger"]): Routine {
  return {
    id,
    name: id,
    definitionId: "wfd_1",
    trigger,
    scope: "bench",
    input: {},
    enabled: true,
    deliveryChannelId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const scheduled = routine("rtn_daily", { kind: "daily", hour: 9, minute: 0 });
const manual = routine("rtn_manual", null);

describe("nextRoutinePathForFilter", () => {
  test("keeps the current selection when it still matches the filter", () => {
    expect(
      nextRoutinePathForFilter([scheduled, manual], "schedule", "rtn_daily"),
    ).toBe("/routines/rtn_daily");
  });

  test("re-picks the first matching routine when the current one drops out", () => {
    expect(
      nextRoutinePathForFilter([scheduled, manual], "demand", "rtn_daily"),
    ).toBe("/routines/rtn_manual");
  });

  test("falls back to the bare list when nothing matches", () => {
    expect(
      nextRoutinePathForFilter([scheduled], "trigger", "rtn_daily"),
    ).toBe("/routines");
  });

  test("with no current selection, picks the first match under the filter", () => {
    expect(nextRoutinePathForFilter([scheduled, manual], "all", null)).toBe(
      "/routines/rtn_daily",
    );
  });

  test("an empty routine list always falls back to the bare list", () => {
    expect(nextRoutinePathForFilter([], "all", null)).toBe("/routines");
  });
});
