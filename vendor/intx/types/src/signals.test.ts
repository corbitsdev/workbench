import { expect, test } from "bun:test";
import { type } from "arktype";

import { signalKinds, signalKindToGateType, SignalKind } from "./signals";

// CL-7443: `message_response` (CL-7190) is retired — `ask_user` posts its
// question and ends the turn instead of parking on a signal, so the reactor
// has no signal kind left but the native `approval` ask.
test("the only signal kind is approval", () => {
  expect(signalKinds).toEqual(["approval"]);
});

test("SignalKind accepts approval and rejects message_response", () => {
  expect(SignalKind("approval")).toBe("approval");
  expect(SignalKind("message_response")).toBeInstanceOf(type.errors);
});

test("signalKindToGateType maps approval to the approval gate", () => {
  expect(signalKindToGateType("approval")).toBe("approval");
});
