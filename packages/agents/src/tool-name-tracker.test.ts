import { describe, expect, it, mock } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createToolNameTracker } from "./tool-name-tracker";

interface Harness {
  transport: Transport;
  emit: (event: unknown) => void;
  path: string | undefined;
  eventName: string | undefined;
  stopped: boolean;
}

function makeHarness(): Harness {
  const h: Harness = {
    transport: undefined as unknown as Transport,
    emit: () => undefined,
    path: undefined,
    eventName: undefined,
    stopped: false,
  };
  h.transport = {
    fetch: mock(async () => undefined as never),
    subscribe: mock(
      (
        path: string,
        onEvent: (e: unknown) => void,
        opts?: { eventName?: string },
      ) => {
        h.path = path;
        h.eventName = opts?.eventName;
        h.emit = onEvent;
        return () => {
          h.stopped = true;
        };
      },
    ),
  };
  return h;
}

const startEvent = (callId: string, name: string) => ({
  type: "inference.tool_call.start",
  seq: 1,
  data: { callId, name, partial: {} },
});

describe("createToolNameTracker", () => {
  it("subscribes to the instance event stream with the agent.event channel", () => {
    const h = makeHarness();
    createToolNameTracker(h.transport, {
      tenantId: "tnt_1",
      instanceId: "ins_1",
    });
    expect(h.path).toBe("/api/tenants/tnt_1/agents/instances/ins_1/events");
    expect(h.eventName).toBe("agent.event");
  });

  it("records callId -> name from inference.tool_call.start events", () => {
    const h = makeHarness();
    const tracker = createToolNameTracker(h.transport, {
      tenantId: "t",
      instanceId: "i",
    });
    h.emit(startEvent("call_00_abcDEF123456", "exa_search"));
    expect(tracker.names.get("call_00_abcDEF123456")).toBe("exa_search");
  });

  it("also records names from inference.tool_call.end events", () => {
    const h = makeHarness();
    const tracker = createToolNameTracker(h.transport, {
      tenantId: "t",
      instanceId: "i",
    });
    h.emit({
      type: "inference.tool_call.end",
      seq: 2,
      data: {
        callId: "call_99_zzz9999999",
        name: "web_fetch",
        arguments: {},
        partial: {},
      },
    });
    expect(tracker.names.get("call_99_zzz9999999")).toBe("web_fetch");
  });

  it("invokes onUpdate only when the map actually changes", () => {
    const h = makeHarness();
    const onUpdate = mock(() => undefined);
    const tracker = createToolNameTracker(
      h.transport,
      { tenantId: "t", instanceId: "i" },
      onUpdate,
    );
    h.emit(startEvent("call_00_abcDEF123456", "exa_search"));
    h.emit(startEvent("call_00_abcDEF123456", "exa_search"));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(tracker.names.size).toBe(1);
  });

  it("ignores unrelated events and malformed payloads", () => {
    const h = makeHarness();
    const tracker = createToolNameTracker(h.transport, {
      tenantId: "t",
      instanceId: "i",
    });
    h.emit({ type: "inference.text.delta", seq: 3, data: { token: "hi" } });
    h.emit(null);
    h.emit({ type: "inference.tool_call.start", seq: 4, data: { callId: 5 } });
    expect(tracker.names.size).toBe(0);
  });

  it("stops the underlying subscription", () => {
    const h = makeHarness();
    const tracker = createToolNameTracker(h.transport, {
      tenantId: "t",
      instanceId: "i",
    });
    tracker.stop();
    expect(h.stopped).toBe(true);
  });
});
