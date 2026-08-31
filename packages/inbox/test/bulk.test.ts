import { describe, expect, test } from "bun:test";

import {
  itemsEligibleForClearDone,
  itemsEligibleForMarkAllRead,
} from "../src/bulk";
import { runBulkOperation } from "../src/bulk-run";
import type { InboxItem } from "../src/project";

function item(
  over: Partial<InboxItem> & Pick<InboxItem, "id" | "group">,
): InboxItem {
  return {
    from: "agent:ops",
    date: "2026-08-10T12:00:00.000Z",
    read: false,
    status: "open",
    ...over,
  };
}

describe("itemsEligibleForMarkAllRead", () => {
  test("skips action items and non-open rows", () => {
    const items = [
      item({ id: "a", group: "action" }),
      item({ id: "m", group: "mention" }),
      item({ id: "d", group: "delivery" }),
      item({ id: "done-m", group: "mention", status: "done" }),
    ];
    const eligible = itemsEligibleForMarkAllRead(items);
    expect(eligible.map((i) => i.id)).toEqual(["m", "d"]);
  });
});

describe("itemsEligibleForClearDone", () => {
  test("selects only done rows", () => {
    const items = [
      item({ id: "a", group: "action" }),
      item({ id: "m", group: "mention", status: "done" }),
      item({ id: "d", group: "delivery", status: "snoozed" }),
    ];
    expect(itemsEligibleForClearDone(items).map((i) => i.id)).toEqual(["m"]);
  });
});

describe("runBulkOperation", () => {
  test("a thrown error on one item does not stop the rest", async () => {
    const applied: string[] = [];
    const failures: { id: string; error: unknown }[] = [];
    const result = await runBulkOperation(
      ["a", "b", "c"],
      async (id) => {
        if (id === "b") throw new Error("transient write failure");
        applied.push(id);
      },
      { onError: (id, error) => failures.push({ id, error }) },
    );

    // Both non-failing items still ran, despite "b" throwing between them —
    // the caller can tell exactly how far the operation got.
    expect(applied).toEqual(["a", "c"]);
    expect(result).toEqual({ succeeded: 2, failed: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.id).toBe("b");
    expect((failures[0]?.error as Error).message).toBe(
      "transient write failure",
    );
  });

  test("every item succeeding reports zero failures", async () => {
    const result = await runBulkOperation(["a", "b"], async () => {});
    expect(result).toEqual({ succeeded: 2, failed: 0 });
  });

  test("onError is optional", async () => {
    const result = await runBulkOperation(["a"], async () => {
      throw new Error("boom");
    });
    expect(result).toEqual({ succeeded: 0, failed: 1 });
  });
});
