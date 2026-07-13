import { describe, test, expect } from "bun:test";

import type { Agent, AgentDefinition, BaseEnv, SendResult } from "@intx/agent";
import { defineAgent } from "@intx/agent";
import { noopAuditStore } from "@intx/agent/testing";
import { createDefaultDirectorRegistry } from "@intx/agent";
import type { AuthorizeContext, StepInvokeRequest } from "@intx/workflow";
import type {
  BlobReader,
  ContextStore,
  InboundMessage,
  InferenceEvent,
  InferenceSource,
} from "@intx/types/runtime";

import { runInlineInferenceStep } from "./inline-inference-step";
import type { StepEnvBase } from "@workbench/workflow-host";

// WORKBENCH-LOCAL (CL-3379): proves inline-inference steps forward their
// event stream to a caller-supplied `onEvent` sink -- the discard behaviour
// this ticket fixes -- and that a throwing sink cannot fail the step, mirroring
// `@workbench/workflow-host`'s `subscribeAgentEvents` contract for the
// launched-step path.

const STUB_SOURCE: InferenceSource = {
  id: "anthropic:stub",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-stub",
  model: "stub-model",
};

function stubContextStore(): ContextStore {
  return {} as ContextStore;
}

function stubBlobReader(): BlobReader {
  return {} as BlobReader;
}

function stubBuildEnv(): Promise<StepEnvBase> {
  return Promise.resolve({
    sources: [STUB_SOURCE],
    defaultSource: STUB_SOURCE.id,
    storage: stubContextStore(),
    workdir: "/tmp/inline-inference-step-stub",
    audit: noopAuditStore(),
    directors: createDefaultDirectorRegistry(),
  });
}

function stubDef(): AgentDefinition<BaseEnv> {
  return defineAgent({
    id: "inline-inference-stub",
    systemPrompt: "stub",
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: STUB_SOURCE.provider, model: STUB_SOURCE.model }],
    },
  });
}

function buildRequest(): StepInvokeRequest {
  const ctrl = new AbortController();
  const authzContext: AuthorizeContext = {
    stepId: "step-1",
    attempt: 1,
    runId: "run-1",
  };
  return {
    agent: stubDef(),
    input: "hello",
    authzContext,
    signal: ctrl.signal,
  };
}

const stubEvent = (type: string): InferenceEvent =>
  ({ type, seq: 1, data: {} }) as unknown as InferenceEvent;

/**
 * Agent stub whose `stream()` yields a fixed sequence of events then ends
 * as soon as `send` resolves (mirroring `close()` terminating the real
 * agent's stream iterator).
 */
function buildStreamingStubAgent(events: InferenceEvent[]): Agent {
  let endStream: () => void = () => {
    /* assigned below */
  };
  const streamEnded = new Promise<void>((resolve) => {
    endStream = resolve;
  });
  return {
    async send(): Promise<SendResult> {
      return {
        reply: "ok",
        turn: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: STUB_SOURCE.model,
          timestamp: 0,
        },
      };
    },
    async *stream() {
      for (const event of events) yield event;
      await streamEnded;
    },
    deliver(_message: InboundMessage) {
      throw new Error("stub deliver() not used");
    },
    async close() {
      endStream();
    },
    setSource(_source: InferenceSource) {
      throw new Error("stub setSource() not used");
    },
    setSources(_sources: InferenceSource[], _defaultSource: string) {
      throw new Error("stub setSources() not used");
    },
    async history() {
      return [];
    },
    async checkpoints() {
      return [];
    },
    async readAt() {
      return [];
    },
    blobReader: stubBlobReader(),
  };
}

describe("runInlineInferenceStep - event forwarding (CL-3379)", () => {
  test("forwards non-message.received events to the supplied onEvent sink", async () => {
    const events = [
      stubEvent("message.received"),
      stubEvent("inference.start"),
      stubEvent("turn.completed"),
    ];
    const agent = buildStreamingStubAgent(events);
    const forwarded: string[] = [];

    const result = await runInlineInferenceStep({
      req: buildRequest(),
      buildEnv: stubBuildEnv,
      agentFactory: () => Promise.resolve(agent),
      onEvent: (event) => {
        forwarded.push(event.type);
      },
    });

    expect(result.output.reply).toBe("ok");
    expect(forwarded).toEqual(["inference.start", "turn.completed"]);
  });

  test("a throwing onEvent sink is swallowed and does not fail the step", async () => {
    const events = [stubEvent("inference.start")];
    const agent = buildStreamingStubAgent(events);

    const result = await runInlineInferenceStep({
      req: buildRequest(),
      buildEnv: stubBuildEnv,
      agentFactory: () => Promise.resolve(agent),
      onEvent: () => {
        throw new Error("sink boom");
      },
    });

    expect(result.output.reply).toBe("ok");
  });

  test("omitting onEvent preserves the drain-only behaviour", async () => {
    const events = [stubEvent("inference.start")];
    const agent = buildStreamingStubAgent(events);

    const result = await runInlineInferenceStep({
      req: buildRequest(),
      buildEnv: stubBuildEnv,
      agentFactory: () => Promise.resolve(agent),
    });

    expect(result.output.reply).toBe("ok");
  });
});
