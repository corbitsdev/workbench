import type {
  CapturedMessage,
  CapturedMessageRole,
  CapturedToolDeclaration,
  ChatCompletionRequestBody,
} from "./types";

function decodeToolCallArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toCapturedMessage(
  message: ChatCompletionRequestBody["messages"][number],
): CapturedMessage {
  return {
    role: message.role,
    content: message.content ?? "",
    ...(message.tool_call_id !== undefined
      ? { toolCallId: message.tool_call_id }
      : {}),
    ...(message.tool_calls !== undefined
      ? {
          toolCalls: message.tool_calls.map((call) => ({
            name: call.function.name,
            arguments: decodeToolCallArguments(call.function.arguments),
          })),
        }
      : {}),
  };
}

/**
 * One `/v1/chat/completions` request the mock received, with the
 * assertion helpers a test actually reaches for — the shape of check
 * that would have caught CL-6448 (`tools: []`, no history reaching the
 * model) had it existed. Every `expect*` throws a message naming what
 * was actually sent, not just that the check failed.
 */
export class CapturedChatRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly tools: readonly CapturedToolDeclaration[];
  readonly messages: readonly CapturedMessage[];

  constructor(body: ChatCompletionRequestBody) {
    this.model = body.model;
    this.stream = body.stream ?? false;
    this.tools = (body.tools ?? []).map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined
        ? { description: t.function.description }
        : {}),
      ...(t.function.parameters !== undefined
        ? { parameters: t.function.parameters }
        : {}),
    }));
    this.messages = body.messages.map(toCapturedMessage);
  }

  toolNames(): readonly string[] {
    return this.tools.map((t) => t.name);
  }

  roles(): readonly CapturedMessageRole[] {
    return this.messages.map((m) => m.role);
  }

  /** Throws unless the request was pinned to exactly this model — catches
   * a request silently falling back to whatever the adapter defaults to. */
  expectModel(model: string): void {
    if (this.model !== model) {
      throw new Error(
        `expected request to be pinned to model "${model}", got "${this.model}"`,
      );
    }
  }

  /**
   * Throws unless at least one tool was declared — the direct CL-6448
   * regression check (`tools: []` reaching the model). Pass `names` to
   * additionally require exactly that set of tool names, independent of
   * declaration order.
   */
  expectToolsDeclared(names?: readonly string[]): void {
    if (this.tools.length === 0) {
      throw new Error(
        "expected request to declare at least one tool, but tools was empty or missing (this is the CL-6448 regression shape)",
      );
    }
    if (names === undefined) return;
    const actual = new Set(this.toolNames());
    const expected = new Set(names);
    const missing = names.filter((name) => !actual.has(name));
    const extra = this.toolNames().filter((name) => !expected.has(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `expected declared tools ${JSON.stringify(names)}, got ${JSON.stringify(this.toolNames())}` +
          (missing.length > 0 ? ` (missing: ${JSON.stringify(missing)})` : "") +
          (extra.length > 0 ? ` (unexpected: ${JSON.stringify(extra)})` : ""),
      );
    }
  }

  /** Throws unless the message roles, in order, exactly match `roles` —
   * catches history collapsing to just `[system, user]` on every turn
   * (CL-6448's other half). */
  expectMessageRoles(roles: readonly CapturedMessageRole[]): void {
    const actual = this.roles();
    const matches =
      actual.length === roles.length &&
      actual.every((role, i) => role === roles[i]);
    if (!matches) {
      throw new Error(
        `expected message roles ${JSON.stringify(roles)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  /**
   * Throws unless `expected` appears, in order, as a subsequence of the
   * captured messages — each entry matched on `role` and, when given, a
   * `content` substring. Use this over `expectMessageRoles` when only
   * part of the history matters (e.g. "the user's original ask is still
   * in there somewhere after three tool round-trips").
   */
  expectHistoryContains(
    expected: readonly { role: CapturedMessageRole; content?: string }[],
  ): void {
    let cursor = 0;
    for (const want of expected) {
      const foundAt = this.messages.findIndex((message, i) => {
        if (i < cursor) return false;
        if (message.role !== want.role) return false;
        if (
          want.content !== undefined &&
          !message.content.includes(want.content)
        ) {
          return false;
        }
        return true;
      });
      if (foundAt === -1) {
        throw new Error(
          `expected history to contain ${JSON.stringify(want)} after position ${cursor}, but it did not appear in ${JSON.stringify(this.messages)}`,
        );
      }
      cursor = foundAt + 1;
    }
  }
}

/** The mock's record of every chat request it has received, oldest first. */
export class CapturedRequestLog {
  private readonly captured: CapturedChatRequest[] = [];

  push(request: CapturedChatRequest): void {
    this.captured.push(request);
  }

  get all(): readonly CapturedChatRequest[] {
    return this.captured;
  }

  get count(): number {
    return this.captured.length;
  }

  /** The most recent request. Throws if the mock has received none yet —
   * a test asserting on `.last()` with no prior call is a test bug, not a
   * "no requests" state worth a silent `undefined`. */
  last(): CapturedChatRequest {
    const request = this.captured.at(-1);
    if (request === undefined) {
      throw new Error("no chat request has been captured yet");
    }
    return request;
  }

  clear(): void {
    this.captured.length = 0;
  }
}
