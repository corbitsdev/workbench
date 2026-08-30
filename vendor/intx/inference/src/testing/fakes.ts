// Minimal fakes for driving a real `createReactor(...)` cycle in tests,
// mirroring `@intx/agent/testing`'s pattern of no-op env-contract
// implementations one level up in this same vendored monorepo. Nothing
// here is provider- or tool-specific: a test wires in whichever
// `ReactorDirector`/`BeforeToolExtension`/turn content it needs.
import type {
  AssistantTurn,
  ContextCommit,
  ContextStore,
  ConversationTurn,
  InboundMessage,
  InferenceEvent,
  InferenceSource,
  LastCycleSource,
  PendingOperation,
  TokenUsage,
  ToolCall,
  ToolResult,
  ToolRunner,
} from "@intx/types/runtime";

import type { Dependencies } from "../harness";

/**
 * In-memory `ContextStore`: keeps the last-written turns/manifest/metadata
 * in plain fields and answers `commit`/`log`/`readAt` off an in-memory
 * commit list. Enough for the reactor's own per-cycle checkpoint sequence
 * (`writeTurns` → `writeManifest` → `writeMetadata` → `commit`) — nothing
 * here is a durability model, it just has to not throw.
 */
export function createInMemoryContextStore(): ContextStore {
  const commits: ContextCommit[] = [];
  let nextHash = 1;

  return {
    load: () =>
      Promise.resolve({
        turns: [] as ConversationTurn[],
        pendingOperations: [] as PendingOperation[],
        tokenUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        connectorState: null,
      }),
    setConnectorState: () => {},
    commit: ({ message }) => {
      const commit: ContextCommit = {
        hash: `commit-${String(nextHash)}`,
        message,
        timestamp: Date.now(),
      };
      nextHash += 1;
      commits.push(commit);
      return Promise.resolve(commit);
    },
    branch: () => Promise.resolve(),
    log: (limit) => Promise.resolve(commits.slice(-(limit ?? commits.length))),
    readAt: () => Promise.resolve([]),
    writeBlob: () => Promise.resolve(),
    readBlob: () => Promise.reject(new Error("no blob written")),
    writePrompt: () => Promise.resolve(),
    writeResponse: () => Promise.resolve(),
    writeManifest: () => Promise.resolve(),
    writeTurns: () => Promise.resolve(),
    writeMetadata: () => Promise.resolve(),
    readManifestHistory: () => Promise.resolve([]),
  };
}

/**
 * A `ToolRunner` that records every call it receives. A suspended call
 * never reaches `run()` (the reactor answers it via the gate instead), so a
 * test asserting the suspend path stays clean asserts `calls` is empty.
 */
export function createRecordingToolRunner(
  resultFor: (call: ToolCall) => ToolResult = (call) => ({
    callId: call.id,
    content: "",
    isError: false,
  }),
): ToolRunner & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    run: (call) => {
      calls.push(call);
      return Promise.resolve(resultFor(call));
    },
  };
}

/** A syntactically valid `InferenceSource` that no fake `inferenceRunner`
 * ever actually dials out to. */
export function createFakeInferenceSource(): InferenceSource {
  return {
    id: "fake-source",
    provider: "fake",
    baseURL: "https://fake.invalid",
    apiKey: "fake-key",
    model: "fake-model",
  };
}

/** A `Dependencies` bag satisfying the reactor's config shape. Never
 * actually invoked by a test that supplies its own `inferenceRunner`
 * (which receives — and can ignore — these as part of its harness opts). */
export function createUnusedDependencies(): Dependencies {
  return {
    fetch: () => Promise.reject(new Error("fetch should never be called")),
    scheduler: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const id = globalThis.setTimeout(fn, ms);
        return () => globalThis.clearTimeout(id);
      },
    },
    adapters: {
      resolve: () => {
        throw new Error("adapters.resolve should never be called");
      },
    } as unknown as Dependencies["adapters"],
  };
}

const FAKE_LAST_CYCLE_SOURCE: LastCycleSource = {
  sourceId: "fake-source",
  provider: "fake",
  model: "fake-model",
};

const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

/** An `AssistantTurn` whose only content is one `tool_call` block — the
 * shape the director needs to see to decide `executeTools`. */
export function assistantTurnWithToolCall(call: ToolCall): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments }],
    model: "fake-model",
    timestamp: Date.now(),
  };
}

/**
 * A scripted `inferenceRunner`: each call to `runner(...)` pops the next
 * queued `AssistantTurn` and yields exactly one `inference.done` event for
 * it. `callCount` lets a test assert exactly how many times inference ran —
 * the whole point of the suspend/resume regression coverage this supports.
 */
export function createScriptedInferenceRunner(turns: AssistantTurn[]): {
  runner: () => AsyncGenerator<InferenceEvent>;
  callCount: () => number;
} {
  const queue = [...turns];
  let calls = 0;

  async function* runner(): AsyncGenerator<InferenceEvent> {
    calls += 1;
    const turn = queue.shift();
    if (turn === undefined) {
      throw new Error(
        `createScriptedInferenceRunner: no scripted turn left for call #${String(calls)}`,
      );
    }
    yield {
      type: "inference.done",
      seq: 0,
      data: { turn, usage: ZERO_USAGE, source: FAKE_LAST_CYCLE_SOURCE },
    };
  }

  return { runner, callCount: () => calls };
}

/** Builds a real `InboundMessage`, optionally carrying an
 * `interchangeCorrelationId` header — the one field `tryCorrelate`
 * (`../reactor.ts`) keys a resumption on. */
export function buildInboundMessage(opts: {
  content: string;
  correlationId?: string;
  messageId?: string;
}): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: opts.messageId ?? `msg-${crypto.randomUUID()}`,
      interchangeType: "conversation.message",
      ...(opts.correlationId !== undefined
        ? { interchangeCorrelationId: opts.correlationId }
        : {}),
    },
    flags: [],
    content: opts.content,
    signatureStatus: "missing",
  };
}
