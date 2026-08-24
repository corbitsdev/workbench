// CL-6832: a pins outage must not read as an honest empty strip. These
// cover the pure status fold `useWorkbenchFeed` applies to the pins
// query — empty success, transient error, and absent-store 404 stay
// distinct kinds.
import { describe, expect, test } from "bun:test";

import { ChatApiError } from "./api";
import { pinsStatusFor } from "./use-workbench-feed";
import type { PinnedMessage } from "./api";
import { CHAT_STRINGS } from "./strings";

const PIN: PinnedMessage = {
  id: "m1",
  createdAt: "2026-01-01T00:00:00.000Z",
  parts: [{ kind: "text", text: "keep this" }],
  sender: { name: "Alice", address: "prn_alice@acme.example" },
  pinnedBy: "prn_alice",
  pinnedAt: "2026-01-01T00:01:00.000Z",
};

describe("pinsStatusFor (CL-6832)", () => {
  test("no active workbench is still loading", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: null,
        data: undefined,
        error: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  test("a successful empty list is ready with no items — not an error", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: "wb_1",
        data: [],
        error: null,
      }),
    ).toEqual({ kind: "ready", items: [] });
  });

  test("a successful list with pins is ready with those items", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: "wb_1",
        data: [PIN],
        error: null,
      }),
    ).toEqual({ kind: "ready", items: [PIN] });
  });

  test("a load failure is an error with plain-language copy — never coerced to []", () => {
    const status = pinsStatusFor({
      activeWorkbenchId: "wb_1",
      data: undefined,
      // A non-5xx client error uses the strip's own fallback copy via
      // describeChatError — the important bit is the kind, not the prose.
      error: new ChatApiError("The server answered 400 for /pins.", 400),
    });
    expect(status).toEqual({
      kind: "error",
      message: CHAT_STRINGS.pinnedStripLoadError,
    });
  });

  test("a 404 (pins store not wired on this host) is unavailable, not empty ready", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: "wb_1",
        data: undefined,
        error: new ChatApiError("The server answered 404 for /pins.", 404),
      }),
    ).toEqual({ kind: "unavailable" });
  });

  test("prior successful data wins over a background refetch error", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: "wb_1",
        data: [PIN],
        error: new ChatApiError("The server answered 500 for /pins.", 500),
      }),
    ).toEqual({ kind: "ready", items: [PIN] });
  });

  test("pending first load with no data and no error is loading", () => {
    expect(
      pinsStatusFor({
        activeWorkbenchId: "wb_1",
        data: undefined,
        error: null,
      }),
    ).toEqual({ kind: "loading" });
  });
});
