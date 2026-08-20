import { describe, expect, test } from "bun:test";

import {
  classificationFromRefs,
  inboxGroupOf,
  isInboxGroup,
} from "../src/group";

describe("inboxGroupOf", () => {
  test("honors an explicit classification", () => {
    expect(
      inboxGroupOf({
        classification: "mention",
        refs: [{ kind: "approval" }],
      }),
    ).toBe("mention");
  });

  test("derives action from an approval ref", () => {
    expect(inboxGroupOf({ refs: [{ kind: "approval" }] })).toBe("action");
  });

  test("derives action from a credential ref", () => {
    expect(inboxGroupOf({ refs: [{ kind: "credential" }] })).toBe("action");
  });

  test("derives mention from a thread ref", () => {
    expect(inboxGroupOf({ refs: [{ kind: "thread" }] })).toBe("mention");
  });

  test("defaults to delivery", () => {
    expect(inboxGroupOf({ refs: [{ kind: "run" }] })).toBe("delivery");
    expect(inboxGroupOf({})).toBe("delivery");
  });
});

describe("classificationFromRefs", () => {
  test("matches the group derivation", () => {
    expect(classificationFromRefs([{ kind: "approval" }])).toBe("action");
    expect(classificationFromRefs([{ kind: "thread" }])).toBe("mention");
    expect(classificationFromRefs([])).toBe("delivery");
  });
});

describe("isInboxGroup", () => {
  test("accepts the three product groups only", () => {
    expect(isInboxGroup("action")).toBe(true);
    expect(isInboxGroup("mention")).toBe(true);
    expect(isInboxGroup("delivery")).toBe(true);
    expect(isInboxGroup("other")).toBe(false);
  });
});
