// Pure control/settings logic for a channel: recognizing a control
// message structurally, parsing its payload, and folding it onto
// participant state as timeline events. Isolated from `@intx/workflow`
// and from any transport so it stays unit-testable without a runtime.
//
// `routes.ts` is this module's only consumer: the settings PATCH route
// uses it to turn a validated settings patch into the event parts it
// posts onto the anchor's timeline as the audit trail. There is no
// relay workflow anymore for this logic to be reached from otherwise
// (see `channel-workflow.ts`).

import { type } from "arktype";
import type { EventPart, Part } from "./parts";

// A control mail is structurally distinguished (never by a magic
// subject string): exactly one `BlockPart` whose `block.type` is this
// namespace. Every other inbound message is an ordinary chat message.
export const CHANNEL_CONTROL_NAMESPACE = "chat/channel-settings";

export const ChannelControlPayload = type({
  namespace: `"${CHANNEL_CONTROL_NAMESPACE}"`,
  "participants?": "string[]",
  "settings?": "Record<string, unknown>",
});
export type ChannelControlPayload = typeof ChannelControlPayload.infer;

export interface ChannelParticipantState {
  readonly participants: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
}

export const EMPTY_CHANNEL_STATE: ChannelParticipantState = {
  participants: [],
  settings: {},
};

/**
 * Structural test for a control message: exactly one block part
 * carrying this package's control namespace. A message with any other
 * shape — including a block part in a different namespace, or a block
 * part alongside other parts — is an ordinary message.
 */
export function isControlMessage(parts: readonly Part[]): boolean {
  if (parts.length !== 1) return false;
  const [part] = parts;
  return (
    part !== undefined &&
    part.kind === "block" &&
    part.block.type === CHANNEL_CONTROL_NAMESPACE
  );
}

/**
 * Parse a control message's payload, rejecting anything malformed
 * loudly rather than silently ignoring it. Callers must have already
 * confirmed `isControlMessage(parts)`.
 */
export function parseControlPayload(
  parts: readonly Part[],
): ChannelControlPayload {
  if (!isControlMessage(parts)) {
    throw new Error(
      "parseControlPayload requires a message that isControlMessage accepts",
    );
  }
  const [part] = parts;
  // isControlMessage already narrowed this to a single BlockPart.
  const block = (part as Extract<Part, { kind: "block" }>).block;
  const result = ChannelControlPayload(block.data);
  if (result instanceof type.errors) {
    throw new Error(`invalid channel control payload: ${result.summary}`);
  }
  return result;
}

export interface ControlApplyResult {
  readonly state: ChannelParticipantState;
  readonly events: readonly EventPart[];
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Apply a parsed control payload to the current participant state.
 * Emits one event part per kind of change so readers of the channel's
 * timeline see "membership changed" and "settings changed" as
 * distinguishable events; a payload that changes neither emits none.
 */
export function applyControlPayload(
  state: ChannelParticipantState,
  payload: ChannelControlPayload,
  updatedBy: string,
): ControlApplyResult {
  const events: EventPart[] = [];
  let participants = state.participants;
  if (
    payload.participants !== undefined &&
    !sameMembers(payload.participants, state.participants)
  ) {
    participants = payload.participants;
    events.push({
      kind: "event",
      event: "channel.membership-changed",
      data: { updatedBy, participants },
    });
  }

  let settings = state.settings;
  if (payload.settings !== undefined) {
    // The event carries the delta and the prior values of the touched
    // keys so timeline readers can say what changed ("Renamed A to B"),
    // not just that something did.
    const previous = Object.fromEntries(
      Object.keys(payload.settings)
        .filter((key) => key in state.settings)
        .map((key) => [key, state.settings[key]]),
    );
    settings = { ...settings, ...payload.settings };
    events.push({
      kind: "event",
      event: "channel.settings-changed",
      data: { updatedBy, settings, changed: payload.settings, previous },
    });
  }

  return { state: { participants, settings }, events };
}
