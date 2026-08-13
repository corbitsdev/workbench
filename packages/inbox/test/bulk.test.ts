import { describe, expect, test } from "bun:test";

import {
  itemsEligibleForClearDone,
  itemsEligibleForMarkAllRead,
} from "../src/bulk";
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
