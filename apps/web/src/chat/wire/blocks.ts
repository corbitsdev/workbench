// Mirrored from packages/chat/src (see docs/chat-wire-contract.md) — apps/web
// must not import @corbits/chat, a server-only package.

import { type } from "arktype";

import type { BlockPart } from "./parts";

// Every schema strips undeclared keys deeply so agent-authored extras (a
// hostile `tally` on a poll) never reach a renderer that trusts them.

// No action labels or resolved state: those live on the approval record,
// never in the message, so an agent can't spoof a decision.
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

// No auth mode or connected/disconnected verdict: an agent that could author
// "connected" would be spoofing live state next to a live button. Real
// state and the connect affordance come from the host at render time.
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
