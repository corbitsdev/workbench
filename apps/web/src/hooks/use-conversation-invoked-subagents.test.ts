/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import {
  CONVERSATION_RUN_IDLE_POLL_MS,
  CONVERSATION_RUN_POLL_MS,
} from "./use-workflow";
import {
  invokedSubagentListIsActive,
  invokedSubagentPollInterval,
  useConversationInvokedSubagents,
} from "./use-conversation-invoked-subagents";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function sampleRow(sessionStatus: string | null) {
  return {
    mappingId: "map-1",
    agentId: "agt-1",
    agentName: "Researcher",
    instanceId: "inst-1",
    instanceAddress: "researcher.local",
    sessionId: sessionStatus === "active" ? "sess-1" : null,
    sessionStatus,
    lastActivityAt: "2026-07-02T10:00:00.000Z",
    firstInvokedAt: "2026-07-02T09:00:00.000Z",
    lastInvokedAt: "2026-07-02T10:00:00.000Z",
    originConversationId: "thread-1",
  };
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("invokedSubagentListIsActive", () => {
  it("is true when any row has an active session", () => {
    expect(invokedSubagentListIsActive([])).toBe(false);
    expect(invokedSubagentListIsActive([{ sessionStatus: "ended" }])).toBe(
      false,
    );
    expect(
      invokedSubagentListIsActive([
        { sessionStatus: "ended" },
        { sessionStatus: "active" },
      ]),
    ).toBe(true);
  });
});

describe("invokedSubagentPollInterval", () => {
  it("uses the fast cadence while any session is active or before first data", () => {
    expect(invokedSubagentPollInterval(undefined)).toBe(
      CONVERSATION_RUN_POLL_MS,
    );
    expect(invokedSubagentPollInterval([{ sessionStatus: "active" }])).toBe(
      CONVERSATION_RUN_POLL_MS,
    );
  });

  it("backs off when every listed session is idle", () => {
    expect(
      invokedSubagentPollInterval([
        { sessionStatus: "ended" },
        { sessionStatus: null },
      ]),
    ).toBe(CONVERSATION_RUN_IDLE_POLL_MS);
  });
});

describe("useConversationInvokedSubagents", () => {
  it("requests invoked subagents scoped to the conversation id", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(
        jsonResponse(200, { subagents: [sampleRow("active")] }),
      );
    }) as typeof fetch;

    const { result } = renderHook(
      () => useConversationInvokedSubagents("thread-1", "tn-x"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain("originConversationId=thread-1");
    expect(requested).toContain("tenantId=tn-x");
    expect(result.current.data?.[0]?.agentName).toBe("Researcher");
  });

  it("is disabled without a conversation id", () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, { subagents: [] }));
    }) as typeof fetch;

    const { result } = renderHook(() => useConversationInvokedSubagents(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(called).toBe(false);
  });
});
