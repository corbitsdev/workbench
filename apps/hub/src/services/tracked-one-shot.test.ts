import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { InferenceEvent, InferenceSource } from "@intx/types/runtime";

// A real, schema-valid inference.done carrying token usage — parseInferenceEvent
// (real, not mocked) must accept this for the analytics path to fire.
const doneEvent: InferenceEvent = {
  type: "inference.done",
  seq: 3,
  data: {
    turn: {
      role: "assistant",
      content: [],
      model: "claude-sonnet-5",
      timestamp: 0,
    },
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: {
      sourceId: "off_1",
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
  },
};

// SDK-synthesized "apology" reply the director sends via capabilities.reply()
// when a turn's own inference cycle ends in an unrecoverable error (CL-3870)
// — send() resolves with this text as if it were a real completion.
const errorEvent: InferenceEvent = {
  type: "inference.error",
  seq: 3,
  data: {
    error: { category: "fatal", message: "credential error" },
    partial: { text: "" },
  },
};

let collectorEvents: string[] = [];
let finalizeText = "Final Title";
let streamEvent: InferenceEvent = doneEvent;
let sendReply = "Reply Text";

mock.module("@intx/agent", () => ({
  defineAgent: mock((def: unknown) => def),
  createDefaultDirectorRegistry: mock(() => ({})),
  createAgent: mock(() =>
    Promise.resolve({
      async *stream() {
        yield streamEvent;
        yield { type: "message.received", data: {} };
      },
      send: mock(() =>
        Promise.resolve({ type: "reply" as const, reply: sendReply }),
      ),
      close: mock(() => Promise.resolve()),
    }),
  ),
}));

let lastCollectorConfig: {
  sessionId: string;
  instanceId: string;
  tenantId: string;
} | null = null;
const collectorOnEvent = mock((event: { type: string }) => {
  collectorEvents.push(event.type);
  return Promise.resolve();
});
mock.module("@workbench/event-collector", () => ({
  createEventCollector: mock(
    (config: {
      sessionId: string;
      instanceId: string;
      tenantId: string;
      onTurnFinalized?: (t: unknown) => void;
    }) => {
      lastCollectorConfig = {
        sessionId: config.sessionId,
        instanceId: config.instanceId,
        tenantId: config.tenantId,
      };
      return {
        onEvent: mock((event: { type: string }) => {
          config.onTurnFinalized?.({
            turnId: "t1",
            status: "completed",
            text: finalizeText,
          });
          return collectorOnEvent(event);
        }),
        abandon: mock(() => Promise.resolve()),
        getAccumulatedText: () => "accumulated",
        getCurrentTurnId: () => null,
        getLastTurnId: () => "t1",
      };
    },
  ),
}));

import { runTrackedOneShot } from "./tracked-one-shot";

const source: InferenceSource = {
  id: "off_1",
  provider: "anthropic",
  baseURL: "https://llm.example/v1",
  apiKey: "sk-x",
  model: "claude-sonnet-5",
};

function makeAnalytics() {
  return {
    onAgentEvent: mock((_event: unknown) => Promise.resolve()),
    onLocalInferenceEvent: mock((_event: unknown) => Promise.resolve()),
  };
}

const baseOpts = {
  // biome-ignore lint/suspicious/noExplicitAny: structural db mock (unused by the mocked collector)
  db: {} as any,
  tenantId: "tnt-1",
  source,
  systemPrompt: "sys",
  agentIdPrefix: "myra-title",
  message: "first message",
  // biome-ignore lint/suspicious/noExplicitAny: opaque scratch store, never touched here
  store: {} as any,
  workdir: "/tmp/x",
};

beforeEach(() => {
  collectorEvents = [];
  finalizeText = "Final Title";
  lastCollectorConfig = null;
  collectorOnEvent.mockClear();
  streamEvent = doneEvent;
  sendReply = "Reply Text";
});

describe("runTrackedOneShot", () => {
  it("forwards usage to analytics AND records the turn in one pump", async () => {
    const analytics = makeAnalytics();
    const text = await runTrackedOneShot({
      ...baseOpts,
      analytics: {
        subscriber: analytics,
        attributionPrincipalId: "prn-caller",
      },
      turnRecording: { sessionId: "ses-1", instanceId: "ins-1" },
    });

    // Turn recording: the collector saw the inference event (message.received
    // is filtered) and the turn finalized, so its text wins.
    expect(text).toBe("Final Title");
    expect(collectorEvents).toEqual(["inference.done"]);
    expect(lastCollectorConfig).toEqual({
      sessionId: "ses-1",
      instanceId: "ins-1",
      tenantId: "tnt-1",
    });

    // Analytics: the schema-valid inference.done was forwarded, attributed to
    // the caller, keyed by the one-shot's own agent id.
    expect(analytics.onLocalInferenceEvent).toHaveBeenCalledTimes(1);
    const call = analytics.onLocalInferenceEvent.mock.calls[0]?.[0] as {
      tenantId: string;
      attributionPrincipalId: string;
      eventAddress: string;
      event: { type: string };
    };
    expect(call.tenantId).toBe("tnt-1");
    expect(call.attributionPrincipalId).toBe("prn-caller");
    expect(call.eventAddress).toMatch(/^myra-title-/);
    expect(call.event.type).toBe("inference.done");
  });

  it("runs analytics-only (no turn recording) and returns the reply", async () => {
    const analytics = makeAnalytics();
    const text = await runTrackedOneShot({
      ...baseOpts,
      agentIdPrefix: "file-parser",
      analytics: {
        subscriber: analytics,
        attributionPrincipalId: "prn-caller",
      },
    });

    // No collector was created → no turn recording, reply text is returned.
    expect(text).toBe("Reply Text");
    expect(lastCollectorConfig).toBeNull();
    expect(collectorEvents).toEqual([]);
    expect(analytics.onLocalInferenceEvent).toHaveBeenCalledTimes(1);
    const call = analytics.onLocalInferenceEvent.mock.calls[0]?.[0] as {
      eventAddress: string;
    };
    expect(call.eventAddress).toMatch(/^file-parser-/);
  });

  it("a failing analytics sink does not starve turn recording", async () => {
    const analytics = makeAnalytics();
    analytics.onLocalInferenceEvent = mock(() =>
      Promise.reject(new Error("analytics down")),
    );
    const text = await runTrackedOneShot({
      ...baseOpts,
      analytics: {
        subscriber: analytics,
        attributionPrincipalId: "prn-caller",
      },
      turnRecording: { sessionId: "ses-1", instanceId: "ins-1" },
    });

    // Analytics threw, but the collector still saw the event and finalized the
    // turn — the sinks are isolated, so the title is not lost to an outage.
    expect(analytics.onLocalInferenceEvent).toHaveBeenCalledTimes(1);
    expect(collectorEvents).toEqual(["inference.done"]);
    expect(text).toBe("Final Title");
  });

  it("runs with neither analytics nor recording and still returns the reply", async () => {
    const text = await runTrackedOneShot(baseOpts);
    expect(text).toBe("Reply Text");
    expect(collectorEvents).toEqual([]);
  });

  it("throws instead of returning the SDK's synthesized error reply when the turn's own inference cycle fails (CL-3870)", async () => {
    // send() resolves normally with the director's apology text even though
    // the turn's inference cycle ended in an unrecoverable error — the exact
    // shape that let a failed title turn persist as if it were real output.
    streamEvent = errorEvent;
    sendReply =
      "This agent could not complete your request due to a credential error [HTTP 402]: insufficient balance";

    await expect(runTrackedOneShot(baseOpts)).rejects.toThrow(
      /Inference turn failed \(fatal\): credential error/,
    );
  });
});
