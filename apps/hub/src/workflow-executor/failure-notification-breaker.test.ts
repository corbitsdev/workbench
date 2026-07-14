import { afterEach, describe, expect, it } from "bun:test";
import {
  failureNotificationKey,
  noteFailureNotification,
  noteSuccessNotification,
  resetFailureNotificationBreaker,
  MAX_CONSECUTIVE_FAILURE_MAILS,
} from "./failure-notification-breaker";

afterEach(() => resetFailureNotificationBreaker());

const KEY = failureNotificationKey("ten-1", "pain-point-collateral", "prn-a");

describe("failure-notification-breaker", () => {
  it("delivers the first N-1 failures plainly, the Nth with a paused notice", () => {
    const decisions = [];
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURE_MAILS; i += 1) {
      decisions.push(noteFailureNotification(KEY));
    }
    // N = 3: two plain, one paused-notice — all delivered.
    expect(decisions).toEqual([
      { deliver: true, pausedNotice: false },
      { deliver: true, pausedNotice: false },
      { deliver: true, pausedNotice: true },
    ]);
  });

  it("suppresses every failure after the cap", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURE_MAILS; i += 1) {
      noteFailureNotification(KEY);
    }
    expect(noteFailureNotification(KEY)).toEqual({
      deliver: false,
      pausedNotice: false,
    });
    expect(noteFailureNotification(KEY)).toEqual({
      deliver: false,
      pausedNotice: false,
    });
  });

  it("a success resets the count so the full budget re-arms", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURE_MAILS; i += 1) {
      noteFailureNotification(KEY);
    }
    expect(noteFailureNotification(KEY).deliver).toBe(false);

    noteSuccessNotification(KEY);

    // Full budget again: first failure delivers plainly.
    expect(noteFailureNotification(KEY)).toEqual({
      deliver: true,
      pausedNotice: false,
    });
  });

  it("different workflow kinds do not interfere", () => {
    const other = failureNotificationKey("ten-1", "another-workflow", "prn-a");
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURE_MAILS; i += 1) {
      noteFailureNotification(KEY);
    }
    expect(noteFailureNotification(KEY).deliver).toBe(false);
    // The other kind still has its full budget.
    expect(noteFailureNotification(other)).toEqual({
      deliver: true,
      pausedNotice: false,
    });
  });

  it("scopes keys by tenant and owner", () => {
    expect(failureNotificationKey("ten-1", "k", "prn-a")).not.toBe(
      failureNotificationKey("ten-2", "k", "prn-a"),
    );
    expect(failureNotificationKey("ten-1", "k", "prn-a")).not.toBe(
      failureNotificationKey("ten-1", "k", "prn-b"),
    );
  });
});
