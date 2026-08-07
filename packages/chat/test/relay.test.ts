// Tests for the pure relay/participant-state logic: fan-out, control
// mail detection, and state transitions. No `@intx/workflow` runtime
// involved — this is the host-independent core the workflow's action
// handler wraps.

import { expect, test } from "bun:test";
import type { Part } from "../src/parts";
import {
  CHANNEL_CONTROL_NAMESPACE,
  EMPTY_CHANNEL_STATE,
  applyControlPayload,
  isControlMessage,
  parseControlPayload,
  planRelay,
} from "../src/relay";
import type { ChannelParticipantState } from "../src/relay";

const STATE_ABC: ChannelParticipantState = {
  participants: ["a", "b", "c"],
  settings: {},
};

test("an inbound message from a participant fans out to every other participant", () => {
  expect(planRelay(STATE_ABC, "a").recipients).toEqual(["b", "c"]);
});

test("the sender is never included among the recipients", () => {
  const plan = planRelay(STATE_ABC, "b");
  expect(plan.recipients).not.toContain("b");
});

test("an empty participant list relays to nobody without erroring", () => {
  expect(() => planRelay(EMPTY_CHANNEL_STATE, "a")).not.toThrow();
  expect(planRelay(EMPTY_CHANNEL_STATE, "a").recipients).toEqual([]);
});

test("a sole participant relaying to themselves plans no recipients", () => {
  const solo: ChannelParticipantState = { participants: ["a"], settings: {} };
  expect(planRelay(solo, "a").recipients).toEqual([]);
});

function controlMail(data: unknown): Part[] {
  return [{ kind: "block", block: { type: CHANNEL_CONTROL_NAMESPACE, data } }];
}

test("a control mail is structurally distinguished from an ordinary message", () => {
  expect(
    isControlMessage(controlMail({ namespace: CHANNEL_CONTROL_NAMESPACE })),
  ).toBe(true);
  expect(isControlMessage([{ kind: "text", text: "hello" }])).toBe(false);
});

test("a block part in a different namespace is not a control message", () => {
  expect(
    isControlMessage([
      { kind: "block", block: { type: "some/other-namespace", data: {} } },
    ]),
  ).toBe(false);
});

test("a control mail bundled with other parts is not a control message", () => {
  expect(
    isControlMessage([
      { kind: "text", text: "hi" },
      { kind: "block", block: { type: CHANNEL_CONTROL_NAMESPACE, data: {} } },
    ]),
  ).toBe(false);
});

test("control mail updates the participant list and yields a membership event", () => {
  const payload = parseControlPayload(
    controlMail({
      namespace: CHANNEL_CONTROL_NAMESPACE,
      participants: ["a", "b"],
    }),
  );
  const result = applyControlPayload(EMPTY_CHANNEL_STATE, payload, "a");
  expect(result.state.participants).toEqual(["a", "b"]);
  expect(result.events).toEqual([
    {
      kind: "event",
      event: "channel.membership-changed",
      data: { updatedBy: "a", participants: ["a", "b"] },
    },
  ]);
});

test("control mail merges settings and yields a settings-changed event", () => {
  const payload = parseControlPayload(
    controlMail({
      namespace: CHANNEL_CONTROL_NAMESPACE,
      settings: { "chat/topic": "launch planning" },
    }),
  );
  const result = applyControlPayload(STATE_ABC, payload, "b");
  expect(result.state.settings).toEqual({ "chat/topic": "launch planning" });
  expect(result.state.participants).toEqual(STATE_ABC.participants);
  expect(result.events).toEqual([
    {
      kind: "event",
      event: "channel.settings-changed",
      data: { updatedBy: "b", settings: { "chat/topic": "launch planning" } },
    },
  ]);
});

test("re-sending the same participant list emits no membership event", () => {
  const payload = parseControlPayload(
    controlMail({
      namespace: CHANNEL_CONTROL_NAMESPACE,
      participants: [...STATE_ABC.participants],
    }),
  );
  const result = applyControlPayload(STATE_ABC, payload, "a");
  expect(result.events).toEqual([]);
});

test("malformed control payloads are rejected loudly", () => {
  expect(() =>
    parseControlPayload(
      controlMail({
        namespace: CHANNEL_CONTROL_NAMESPACE,
        participants: "not-an-array",
      }),
    ),
  ).toThrow();
  expect(() =>
    parseControlPayload(controlMail({ namespace: "wrong-namespace" })),
  ).toThrow();
});

test("parseControlPayload refuses a message that is not structurally control mail", () => {
  expect(() => parseControlPayload([{ kind: "text", text: "hi" }])).toThrow(
    /isControlMessage/,
  );
});
