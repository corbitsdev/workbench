// Ollama's OpenAI-compatible endpoint sometimes emits a declared tool call
// as a JSON object in `content` instead of native `tool_calls` (CL-7186).
// `@intx/inference`'s OpenAI parser only reads `delta.tool_calls`, so that
// JSON rides downstream as assistant text and the tool never runs. This
// module reclassifies a content stream that is exactly that object into
// `inference.tool_call.*` events, gated on the tools declared for the
// request so unknown names and ordinary JSON answers stay text.
import type { InferenceEvent } from "@intx/types/runtime";

export type InlineToolJsonState = {
  declaredNames: Set<string>;
  held: InferenceEvent[];
  acc: string;
  verdict: "pending" | "text" | "tool";
};

export function createInlineToolJsonState(
  declaredNames: Iterable<string> = [],
): InlineToolJsonState {
  return {
    declaredNames: new Set(declaredNames),
    held: [],
    acc: "",
    verdict: "pending",
  };
}

export function setDeclaredToolNames(
  state: InlineToolJsonState,
  tools: readonly { name: string }[] | undefined,
): void {
  state.declaredNames = new Set((tools ?? []).map((tool) => tool.name));
}

const INLINE_TOOL_CALL_ID = "ollama-inline-0";
const EMPTY_PARTIAL = { text: "" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

type ParseResult =
  | { kind: "incomplete" }
  | { kind: "reject" }
  | { kind: "object"; value: Record<string, unknown> };

function parseExactObject(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "incomplete" };
  }
  if (trimmed.startsWith("{") === false) {
    return { kind: "reject" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainObject(parsed)) {
      return { kind: "reject" };
    }
    return { kind: "object", value: parsed };
  } catch {
    return { kind: "incomplete" };
  }
}

function salvageToolCall(
  value: Record<string, unknown>,
  declaredNames: ReadonlySet<string>,
): { name: string; args: Record<string, unknown> } | null {
  for (const key of Object.keys(value)) {
    if (
      key !== "name" &&
      key !== "parameters" &&
      key !== "arguments" &&
      key !== "id"
    ) {
      return null;
    }
  }
  const name = value["name"];
  if (typeof name !== "string" || declaredNames.has(name) === false) {
    return null;
  }
  const hasParameters = Object.hasOwn(value, "parameters");
  const hasArguments = Object.hasOwn(value, "arguments");
  if (hasParameters === hasArguments) {
    return null;
  }
  const raw = hasParameters ? value["parameters"] : value["arguments"];
  if (!isPlainObject(raw)) {
    return null;
  }
  const id = value["id"];
  if (id !== undefined && typeof id !== "string") {
    return null;
  }
  return { name, args: raw };
}

function lastHeldText(
  held: readonly InferenceEvent[],
): InferenceEvent | undefined {
  for (let i = held.length - 1; i >= 0; i--) {
    const event = held[i];
    if (event?.type === "inference.text.delta") {
      return event;
    }
  }
  return undefined;
}

function emitToolCallEvents(
  salvaged: { name: string; args: Record<string, unknown> },
  template: InferenceEvent | undefined,
): InferenceEvent[] {
  const seq = template?.seq ?? 0;
  const index =
    template?.type === "inference.text.delta" &&
    template.data.index !== undefined
      ? template.data.index
      : 0;
  return [
    {
      type: "inference.tool_call.start",
      seq,
      data: {
        callId: INLINE_TOOL_CALL_ID,
        name: salvaged.name,
        partial: EMPTY_PARTIAL,
        index,
      },
    },
    {
      type: "inference.tool_call.delta",
      seq,
      data: {
        // Same id as start. The harness keys open tool calls by start's
        // callId and resolves a delta as `indexToCallId.get(callId) ??
        // callId`; a matching id attaches arguments. OpenAI's
        // `String(index)` placeholder is only for native continuation
        // deltas that omit the real id — this salvage mints both events.
        callId: INLINE_TOOL_CALL_ID,
        argumentFragment: JSON.stringify(salvaged.args),
        partial: EMPTY_PARTIAL,
        index,
      },
    },
  ];
}

function matchingSalvage(
  state: InlineToolJsonState,
): { name: string; args: Record<string, unknown> } | null {
  const parsed = parseExactObject(state.acc);
  if (parsed.kind !== "object") {
    return null;
  }
  return salvageToolCall(parsed.value, state.declaredNames);
}

function releaseHeldAsText(
  output: InferenceEvent[],
  state: InlineToolJsonState,
): void {
  output.push(...state.held);
  state.held = [];
  state.verdict = "text";
}

function flushPending(
  output: InferenceEvent[],
  state: InlineToolJsonState,
): void {
  if (state.verdict !== "pending") {
    return;
  }
  if (state.held.length === 0 && state.acc === "") {
    return;
  }
  const salvaged = matchingSalvage(state);
  if (salvaged !== null) {
    output.push(...emitToolCallEvents(salvaged, lastHeldText(state.held)));
    state.held = [];
    state.verdict = "tool";
    return;
  }
  releaseHeldAsText(output, state);
}

function inspectHeldText(
  output: InferenceEvent[],
  state: InlineToolJsonState,
): void {
  const parsed = parseExactObject(state.acc);
  if (parsed.kind === "incomplete") {
    return;
  }
  if (parsed.kind === "reject") {
    releaseHeldAsText(output, state);
    return;
  }
  if (salvageToolCall(parsed.value, state.declaredNames) === null) {
    releaseHeldAsText(output, state);
  }
}

export function responseChunkIsTerminal(sseData: string): boolean {
  try {
    const parsed: unknown = JSON.parse(sseData);
    if (!isPlainObject(parsed)) {
      return false;
    }
    if (parsed["usage"] != null) {
      return true;
    }
    const choices = parsed["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return false;
    }
    const first: unknown = choices[0];
    if (!isPlainObject(first)) {
      return false;
    }
    const reason = first["finish_reason"];
    return typeof reason === "string" && reason.length > 0;
  } catch {
    return false;
  }
}

/**
 * Rewrites one `parseResponse`/`parseJSONResponse` result so a content
 * stream that is exactly a declared-tool JSON object becomes tool-call
 * events instead of text. `state` is mutated in place so a caller threads
 * the same instance across every chunk of one response. Pass `flush` on
 * the terminal chunk (finish_reason / complete JSON body) so a matching
 * object is committed only once the stream cannot grow trailing prose.
 */
export function reclassifyInlineToolJsonEvents(
  events: readonly InferenceEvent[],
  state: InlineToolJsonState,
  opts?: { flush?: boolean },
): InferenceEvent[] {
  if (state.declaredNames.size === 0) {
    return [...events];
  }

  const output: InferenceEvent[] = [];

  for (const event of events) {
    if (state.verdict === "text") {
      output.push(event);
      continue;
    }
    if (state.verdict === "tool") {
      if (event.type !== "inference.text.delta") {
        output.push(event);
      }
      continue;
    }
    if (event.type === "inference.text.delta") {
      state.acc += event.data.token;
      state.held.push(event);
      inspectHeldText(output, state);
      continue;
    }
    if (event.type === "inference.usage") {
      flushPending(output, state);
      output.push(event);
      continue;
    }
    if (
      event.type === "inference.tool_call.start" ||
      event.type === "inference.tool_call.delta" ||
      event.type === "inference.tool_call.end"
    ) {
      releaseHeldAsText(output, state);
      output.push(event);
      continue;
    }
    output.push(event);
  }

  if (opts?.flush === true) {
    flushPending(output, state);
  }

  return output;
}
