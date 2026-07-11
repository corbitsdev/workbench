/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LaunchInstanceSessionResponse } from "../lib/hub-api";

// A terminal stream error (CL-3148's give-up path) must tear down every
// sibling tracker subscription the same way unmount does, not just the main
// session subscription — otherwise the trackers keep retrying to their own
// give-up cap after the UI has already shown phase=error (CL-3211). This
// module-mocks instance-transport and the tracker factories directly so the
// terminal failure can be triggered synchronously instead of waiting out a
// real give-up timer.
let capturedOnStreamError: ((err: Error) => void) | null = null;

mock.module("../lib/instance-transport", () => ({
  createHubTransport: mock(
    (opts?: { onStreamError?: (err: Error) => void }) => {
      capturedOnStreamError = opts?.onStreamError ?? null;
      return { fetch: mock(), subscribe: mock(() => () => undefined) };
    },
  ),
  fetchBlobObjectUrl: mock(() => Promise.resolve("blob:stub")),
}));

const mockToolNamesStop = mock();
const mockLiveTextStop = mock();
const mockReasoningStop = mock();
const mockImageStop = mock();

mock.module("@workbench/agents/browser", () => ({
  composeChatMessages: mock(() => ({ messages: [] })),
  friendlyToolSummary: mock(() => ""),
  friendlyToolResult: mock(() => null),
  isCatalogMetaTool: mock(() => false),
  isExternalIntegrationTool: mock(() => false),
  summarizeToolCalls: mock(() => []),
  createToolNameTracker: mock(() => ({
    names: {},
    stop: mockToolNamesStop,
  })),
  createLiveTextTracker: mock(() => ({ text: "", stop: mockLiveTextStop })),
  createReasoningTracker: mock(() => ({ text: "", stop: mockReasoningStop })),
  createImageTracker: mock(() => ({ images: [], stop: mockImageStop })),
}));

const mockStop = mock();
const mockDestroy = mock();
const mockStart = mock(() => mockStop);
const mockCreateInstanceSession = mock(() => ({
  events: [],
  streaming: "",
  activity: null,
  hydrated: false,
  start: mockStart,
  sendMail: mock(() => Promise.resolve()),
  destroy: mockDestroy,
}));

mock.module("@intx/hub-client", () => ({
  createInstanceSession: mockCreateInstanceSession,
  ApiError: class ApiError extends Error {},
}));

const { AgentChat } = await import("./AgentChat");

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

class NoopEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  close(): void {}
}

let launchQueue: LaunchInstanceSessionResponse[] = [];
let defaultLaunch: LaunchInstanceSessionResponse = {
  launched: true,
  sessionId: null,
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  (
    globalThis as unknown as {
      window: { happyDOM: { setURL: (u: string) => void } };
    }
  ).window.happyDOM.setURL("http://localhost/");
  launchQueue = [];
  defaultLaunch = { launched: true, sessionId: null };
  capturedOnStreamError = null;
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/sessions")) {
      return Promise.resolve(
        jsonResponse(launchQueue.length ? launchQueue.shift() : defaultLaunch),
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
  globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  mockCreateInstanceSession.mockClear();
  mockStart.mockClear();
  mockStop.mockClear();
  mockDestroy.mockClear();
  mockToolNamesStop.mockClear();
  mockLiveTextStop.mockClear();
  mockReasoningStop.mockClear();
  mockImageStop.mockClear();
});

function renderAgentChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat instanceId="ins_123" tenantId="tnt_123" agentName="Loop" />
    </QueryClientProvider>,
  );
}

describe("AgentChat — terminal stream error teardown", () => {
  it("stops every sibling tracker subscription, not just the session, on a terminal stream error", async () => {
    renderAgentChat();

    await waitFor(() => {
      expect(mockStart).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(capturedOnStreamError).not.toBeNull();
    });

    act(() => {
      capturedOnStreamError?.(new Error("gave up reconnecting"));
    });

    expect(mockStop).toHaveBeenCalled();
    expect(mockToolNamesStop).toHaveBeenCalled();
    expect(mockLiveTextStop).toHaveBeenCalled();
    expect(mockReasoningStop).toHaveBeenCalled();
    expect(mockImageStop).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();
  });
});
