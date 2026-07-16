/// <reference types="bun" />
import { beforeEach, describe, expect, it } from "bun:test";
import {
  isMyraThreadUsed,
  markMyraThreadUsedLocally,
  resetLocallyUsedMyraThreads,
} from "./myra-threads-cache";

beforeEach(() => {
  resetLocallyUsedMyraThreads();
});

// A thread is "used" once its first message exists — either the hub says so
// (firstMessageAt set) or this client just sent one (local mark). Unused
// threads stay out of the sidebar and /chats so a fresh "+ New chat" never
// mutates the lists until it is actually used (CL-3749).
describe("isMyraThreadUsed", () => {
  it("treats a thread with a server-recorded first message as used", () => {
    expect(
      isMyraThreadUsed({
        instanceId: "inst-1",
        firstMessageAt: "2026-07-15T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("treats a thread with no first message as unused", () => {
    expect(
      isMyraThreadUsed({ instanceId: "inst-1", firstMessageAt: null }),
    ).toBe(false);
  });

  it("treats a thread as used once this client marks it locally, even before the hub refetch lands", () => {
    markMyraThreadUsedLocally("inst-1");
    expect(
      isMyraThreadUsed({ instanceId: "inst-1", firstMessageAt: null }),
    ).toBe(true);
    // Other threads are unaffected.
    expect(
      isMyraThreadUsed({ instanceId: "inst-2", firstMessageAt: null }),
    ).toBe(false);
  });
});
