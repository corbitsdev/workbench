// Tests for the pure control/settings logic: control mail detection
// and state transitions into timeline events. No `@intx/workflow`
// runtime involved, and no relay/fan-out logic here anymore — that was
// deleted along with the relay workflow (see `channel-workflow.ts`).

import { expect, test } from "bun:test";
import type { Part } from "../src/parts";
import {
  CHANNEL_CONTROL_NAMESPACE,
  EMPTY_CHANNEL_STATE,
  applyControlPayload,
  isControlMessage,
  parseControlPayload,
} from "../src/settings-control";
import type { ChannelParticipantState } from "../src/settings-control";

const STATE_ABC: ChannelParticipantState = {
  participants: ["a", "b", "c"],
  settings: {},
};

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
