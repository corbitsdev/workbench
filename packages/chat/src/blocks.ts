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

// Choices carry no percentages or counts: tallies come from stored
// responses, not agent-authored numbers.
export const PollBlockData = type({
  pollId: "string",
  title: "string",
  choices: type({
    id: "string",
    label: "string",
  }).array(),
  "multi?": "boolean",
  "closesAt?": "string.date.iso",
}).onDeepUndeclaredKey("delete");
export type PollBlockData = typeof PollBlockData.infer;

// A select field must bring its options; the other inputs have none. The
// discriminated union makes that a parse-time guarantee and lets renderers
// narrow on `input` without defaulting a missing list.
const SelectFormField = type({
  id: "string",
  label: "string",
  input: "'select'",
  options: "string[] > 0",
  "value?": "string",
  "required?": "boolean",
});

const PlainFormField = type({
  id: "string",
  label: "string",
  input: "'text' | 'textarea' | 'checkbox'",
  "value?": "string",
  "required?": "boolean",
});

export const FormBlockData = type({
  formId: "string",
  title: "string",
  fields: SelectFormField.or(PlainFormField).array(),
  "submitLabel?": "string",
}).onDeepUndeclaredKey("delete");
export type FormBlockData = typeof FormBlockData.infer;

export const StreamBlockData = type({
  title: "string",
  text: "string",
  done: "boolean",
}).onDeepUndeclaredKey("delete");
export type StreamBlockData = typeof StreamBlockData.infer;

// An interview question with lettered options, posed by an agent
// (`ask_user`, `@corbits/interaction-tools`) and answered in-thread. Like
// `PollBlockData`, it carries no resolved answer — the chosen option (or
// free-text) lives in the block-response row, read back through the same
// `/blocks/:blockId/responses` surface polls use, never in the message.
export const QuestionBlockData = type({
  questionId: "string",
  question: "string",
  "subtitle?": "string",
  options: "2 <= string[] <= 6",
  "allowFreeText?": "boolean",
}).onDeepUndeclaredKey("delete");
export type QuestionBlockData = typeof QuestionBlockData.infer;

// A template room's inline GitHub connect card (CL-6345). Like
// `ApproveBlockData`, this carries only the agent/server-authored
// framing that decided the card exists at all — which connector the
// template still needs, and (once connected) the display-only org
// login. It never carries the live repo list, the person's selection,
// or a connected/disconnected verdict beyond what the room's own
// settings say: an agent authoring this block could otherwise spoof
// "already connected" or plant a fake repo list next to live buttons,
// exactly the confused-deputy failure mode this file's other blocks
// guard against. The card's actual live state — repos, selection, and
// the connected verdict itself — comes from a host-supplied actions
// port at render time, resolved against the room's real connection and
// settings, never from this data.
const ConnectGithubDisconnectedData = type({
  requiredForTemplate: "string > 0",
  state: "'disconnected'",
}).onDeepUndeclaredKey("delete");

const ConnectGithubConnectedData = type({
  requiredForTemplate: "string > 0",
  state: "'connected'",
  orgName: "string",
}).onDeepUndeclaredKey("delete");

export const ConnectGithubBlockData = ConnectGithubDisconnectedData.or(
  ConnectGithubConnectedData,
);
export type ConnectGithubBlockData = typeof ConnectGithubBlockData.infer;

export type Block =
  | { readonly type: "approve"; readonly data: ApproveBlockData }
  | { readonly type: "steps"; readonly data: StepsBlockData }
  | { readonly type: "metrics"; readonly data: MetricsBlockData }
  | { readonly type: "poll"; readonly data: PollBlockData }
  | { readonly type: "form"; readonly data: FormBlockData }
  | { readonly type: "stream"; readonly data: StreamBlockData }
  | { readonly type: "question"; readonly data: QuestionBlockData }
  | { readonly type: "connect-github"; readonly data: ConnectGithubBlockData };

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
    case "poll": {
      const data = PollBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "poll", data } };
    }
    case "form": {
      const data = FormBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "form", data } };
    }
    case "stream": {
      const data = StreamBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "stream", data } };
    }
    case "question": {
      const data = QuestionBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "question", data } };
    }
    case "connect-github": {
      const data = ConnectGithubBlockData(envelope.data);
      if (data instanceof type.errors) {
        return { ok: false, type: envelope.type, summary: data.summary };
      }
      return { ok: true, block: { type: "connect-github", data } };
    }
    default:
      return {
        ok: false,
        type: envelope.type,
        summary: `unknown block type "${envelope.type}"`,
      };
  }
}
