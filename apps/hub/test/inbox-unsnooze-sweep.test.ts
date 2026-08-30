// The sweep's own orchestration — find due snoozes, claim-and-reopen each,
// publish only on an actual reopen, and never drop a row on a claim
// failure — against an in-memory fake store. Which rows are due, and the
// transactional delete+reopen claim itself, are `@corbits/inbox`'s own
// concern (`findDueSnoozes`/`claimAndReopenSnooze`); this only checks the
// tick loop calls them correctly and behaves on what comes back.
import { describe, expect, test } from "bun:test";
import type { MailboxEvent, MailboxEventScope } from "@corbits/mailbox";
import {
  tickInboxUnsnoozeSweep,
  type InboxUnsnoozeSweepStore,
} from "../src/inbox-unsnooze-sweep";
import type { DueSnooze } from "@corbits/inbox";

function row(overrides: Partial<DueSnooze> = {}): DueSnooze {
  return {
    tenantId: "tnt_1",
    principalId: "prn_1",
    messageId: "msg_1",
    ...overrides,
  };
}

function fakeBus() {
  const published: { scope: MailboxEventScope; event: MailboxEvent }[] = [];
  return {
    published,
    bus: {
      publish(scope: MailboxEventScope, event: MailboxEvent) {
        published.push({ scope, event });
      },
    },
  };
}

describe("tickInboxUnsnoozeSweep", () => {
  test("reopens every due row and publishes a reopened event for each", async () => {
    const due = [row({ messageId: "msg_1" }), row({ messageId: "msg_2" })];
    const claimed: DueSnooze[] = [];
    const store: InboxUnsnoozeSweepStore = {
      findDueSnoozes: async () => due,
      claimAndReopen: async (candidate) => {
        claimed.push(candidate);
        return true;
      },
    };
    const { bus, published } = fakeBus();

    await tickInboxUnsnoozeSweep({ store, bus }, new Date());

    expect(claimed.map((c) => c.messageId)).toEqual(["msg_1", "msg_2"]);
    expect(published).toHaveLength(2);
    expect(published[0]?.event).toEqual({
      type: "mailbox",
      id: "msg_1",
      op: "enrich",
    });
  });

  test("does not publish when claimAndReopen reports it reopened nothing", async () => {
    const store: InboxUnsnoozeSweepStore = {
      findDueSnoozes: async () => [row()],
      // False: another replica already claimed it, or the message had
      // already left `snoozed` — either way, no event to publish.
      claimAndReopen: async () => false,
    };
    const { bus, published } = fakeBus();

    await tickInboxUnsnoozeSweep({ store, bus }, new Date());

    expect(published).toHaveLength(0);
  });

  test("a throw from claimAndReopen is swallowed per-row and does not publish", async () => {
    const due = [row({ messageId: "msg_bad" }), row({ messageId: "msg_ok" })];
    const claimed: string[] = [];
    const store: InboxUnsnoozeSweepStore = {
      findDueSnoozes: async () => due,
      claimAndReopen: async (candidate) => {
        claimed.push(candidate.messageId);
        if (candidate.messageId === "msg_bad") {
          throw new Error("connection reset mid-claim");
        }
        return true;
      },
    };
    const { bus, published } = fakeBus();

    // Must not throw out of the tick — one bad row shouldn't abort the rest.
    await tickInboxUnsnoozeSweep({ store, bus }, new Date());

    expect(claimed).toEqual(["msg_bad", "msg_ok"]);
    // Only the row that actually reopened publishes; the thrown claim is
    // left for the next tick to retry (claimAndReopenSnooze's transaction
    // rolls back on a throw, so the snooze row is still there) rather than
    // being dropped.
    expect(published).toHaveLength(1);
    expect(published[0]?.event.id).toBe("msg_ok");
  });
});
