// Mirrored from packages/chat/src: apps/web and @corbits/chat-ui must not
// import @corbits/chat, a server-only package.

import { type } from "arktype";

import type { BlockPart } from "./parts";

// The typed vocabulary for `BlockPart.block` payloads. `BlockPart` stays
// `{ type: string, data: unknown }` on the wire so unknown types degrade to
// a labeled fallback instead of failing the whole message; `parseBlock` is
// the render-boundary parse that turns that envelope into a typed block.
// Every schema strips undeclared keys deeply: agent-authored extras (say, a
// hostile `tally` object on a poll) must never ride along on the parsed
// object a renderer trusts.

// An approve block carries only a reference to a platform approval plus the
// agent's framing. It deliberately has no action labels and no resolved
// state: free-form button text on an approval card is a spoofing surface,
// and the decision's status lives on the approval record, never in the
// message.
export const ApproveBlockData = type({
  approvalId: "string",
  title: "string",
  "risk?": "'low' | 'medium' | 'high'",
  "riskNote?": "string",
  "body?": "string",
}).onDeepUndeclaredKey("delete");
export type ApproveBlockData = typeof ApproveBlockData.infer;

export const StepsBlockData = type({
  title: "string",
  steps: type({
    label: "string",
    state: "'queued' | 'running' | 'done' | 'error'",
    "note?": "string",
  }).array(),
}).onDeepUndeclaredKey("delete");
export type StepsBlockData = typeof StepsBlockData.infer;

export const MetricsBlockData = type({
  title: "string",
  metrics: type({
    label: "string",
    value: "string",
    "detail?": "string",
    // Coloring a delta is a semantic, not a string: without a declared
    // trend the detail renders neutral, so "+40% error rate" can't paint
    // itself success-green.
    "trend?": "'up' | 'down'",
  }).array(),
  "bars?": type({
    label: "string",
    percent: "0 <= number <= 100",
  }).array(),
}).onDeepUndeclaredKey("delete");
export type MetricsBlockData = typeof MetricsBlockData.infer;

export const StreamBlockData = type({
  title: "string",
  text: "string",
  done: "boolean",
}).onDeepUndeclaredKey("delete");
export type StreamBlockData = typeof StreamBlockData.infer;

// An agent-authored "connect this service" card, the
// generalization of `connect-github` to every connector and MCP preset:
// `request_connection` posts one of these instead of a prose deep link.
// It carries only the framing the agent decided — which service, and the
// consumer-language reason it would unlock — never an auth mode or a
// connected/disconnected verdict: an agent that could author "connected"
// (or steer OAuth vs key-paste) would be spoofing live state next to a
// live button. The card's real state and connect affordance come from a
// host-supplied actions port resolved against the tenant's actual
// connections at render time.
export const ConnectServiceBlockData = type({
  connectorId: "string > 0",
  displayName: "string > 0",
  reason: "string > 0",
}).onDeepUndeclaredKey("delete");
export type ConnectServiceBlockData = typeof ConnectServiceBlockData.infer;

export type Block =
  | { readonly type: "approve"; readonly data: ApproveBlockData }
  | { readonly type: "steps"; readonly data: StepsBlockData }
  | { readonly type: "metrics"; readonly data: MetricsBlockData }
  | { readonly type: "stream"; readonly data: StreamBlockData }
  | {
      readonly type: "connect-service";
      readonly data: ConnectServiceBlockData;
    };

export type BlockParseResult =
  | { readonly ok: true; readonly block: Block }
  | { readonly ok: false; readonly type: string; readonly summary: string };

/**
 * Parse a `BlockPart` envelope into a typed block at the render boundary.
 * An unknown type or invalid data yields an `ok: false` result for the
 * caller's fallback card — never a throw, so one malformed block can't take
 * down a timeline.
 */
export function parseBlock(envelope: BlockPart["block"]): BlockParseResult {
  switch (envelope.type) {
    case "approve": {
      const data = ApproveBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "approve", data } };
    }
    case "steps": {
      const data = StepsBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "steps", data } };
    }
    case "metrics": {
      const data = MetricsBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "metrics", data } };
    }
    case "stream": {
      const data = StreamBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "stream", data } };
    }
    case "connect-service": {
      const data = ConnectServiceBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "connect-service", data } };
    }
    default:
      return {
        ok: false,
        type: envelope.type,
        summary: `unknown block type "${envelope.type}"`,
      };
  }
}
