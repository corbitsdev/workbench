// A bus publish failure after a committed reopen must still reach
// reportError — the sweep's other catches already do; the publish helper
// used to log only, so a flaky event bus left no refId.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DueSnooze } from "@corbits/inbox";
import type { MailboxEvent, MailboxEventScope } from "@corbits/mailbox";
import type { InboxUnsnoozeSweepStore } from "../src/inbox-unsnooze-sweep";

const reportErrorCalls: {
  error: unknown;
  context: Record<string, unknown>;
}[] = [];

mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "ref_test";
  },
  generateRefId: () => "ref_test",
}));

const { tickInboxUnsnoozeSweep } = await import("../src/inbox-unsnooze-sweep");

function row(overrides: Partial<DueSnooze> = {}): DueSnooze {
  return {
    tenantId: "tnt_1",
    principalId: "prn_1",
    messageId: "msg_1",
    ...overrides,
  };
}

beforeEach(() => {
  reportErrorCalls.length = 0;
});
afterAll(() => {
  mock.restore();
});

describe("tickInboxUnsnoozeSweep reportError", () => {
  test("a throwing mailbox publish reports through reportError and does not fail the tick", async () => {
    const store: InboxUnsnoozeSweepStore = {
      findDueSnoozes: async () => [row()],
      claimAndReopen: async () => true,
    };
    const bus = {
      publish(_scope: MailboxEventScope, _event: MailboxEvent) {
        throw new Error("bus unavailable");
      },
    };

    await tickInboxUnsnoozeSweep({ store, bus }, new Date());

    expect(reportErrorCalls).toHaveLength(1);
    const reported = reportErrorCalls[0]?.error;
    expect(reported).toBeInstanceOf(Error);
    if (!(reported instanceof Error)) throw new Error("expected Error");
    expect(reported.message).toBe("bus unavailable");
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "inbox_unsnooze_sweep_publish",
      tenantId: "tnt_1",
      extra: { messageId: "msg_1", principalId: "prn_1" },
    });
  });
});
