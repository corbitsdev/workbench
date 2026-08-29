import { expect, test } from "bun:test";

import {
  extractOriginatingWorkbenchId,
  originatingWorkbenchIdFromRequest,
  resolveOriginatingWorkbenchId,
  UNSCOPED_ORIGINATING_WORKBENCH_ID,
} from "./originating-workbench";

function mailRequest(from: string) {
  return {
    input: {
      headers: { from, to: ["myra@alice.localhost"] },
      rawHeaders: {},
      parts: [],
    },
  };
}

test("extractOriginatingWorkbenchId reads the From local-part", () => {
  expect(extractOriginatingWorkbenchId("chan_room_a@alice.localhost")).toBe(
    "chan_room_a",
  );
  expect(
    extractOriginatingWorkbenchId("Workbench <ins_workbench1@alice.localhost>"),
  ).toBe("ins_workbench1");
});

test("extractOriginatingWorkbenchId is undefined for an empty or bare From", () => {
  expect(extractOriginatingWorkbenchId("")).toBeUndefined();
  expect(extractOriginatingWorkbenchId("@alice.localhost")).toBeUndefined();
});

test("resolveOriginatingWorkbenchId uses the unscoped sentinel when From is missing", () => {
  expect(resolveOriginatingWorkbenchId(undefined)).toBe(
    UNSCOPED_ORIGINATING_WORKBENCH_ID,
  );
  expect(resolveOriginatingWorkbenchId("chan_a")).toBe("chan_a");
});

test("originatingWorkbenchIdFromRequest is a function of this request's mail", () => {
  expect(
    originatingWorkbenchIdFromRequest(mailRequest("chan_a@alice.localhost")),
  ).toBe("chan_a");
  expect(
    originatingWorkbenchIdFromRequest(mailRequest("chan_b@alice.localhost")),
  ).toBe("chan_b");
});

test("a resumed input delivers the decision's mail, not the original input", () => {
  expect(
    originatingWorkbenchIdFromRequest({
      ...mailRequest("chan_a@alice.localhost"),
      resume: {
        correlationId: "c1",
        kind: "input",
        decision: mailRequest("chan_b@alice.localhost").input,
      },
    }),
  ).toBe("chan_b");
});

test("a request without mail names no room", () => {
  expect(originatingWorkbenchIdFromRequest({ input: "plain text" })).toBe(
    undefined,
  );
  expect(
    originatingWorkbenchIdFromRequest({
      input: mailRequest("chan_a@alice.localhost").input,
      resume: { correlationId: "c1", kind: "approval", decision: "approved" },
    }),
  ).toBe(undefined);
});
