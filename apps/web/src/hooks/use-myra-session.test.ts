/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

class FakeApiError extends Error {
  status: number;
  constructor(status: number) {
    super("api error");
    this.status = status;
  }
}

const destroyed: number[] = [];
const launchInstanceSession = mock((_id: string) =>
  Promise.resolve({ launched: true }),
);
const ensureMeSynced = mock(() =>
  Promise.resolve({
    personalTenantId: "tenant-1",
    credentialResolved: true,
    paInstanceId: "fallback-should-not-be-used",
  }),
);

mock.module("@intx/hub-client", () => ({
  ApiError: FakeApiError,
  createInstanceSession: () => {
    const idx = destroyed.length;
    destroyed.push(0);
    return {
      events: [],
      activity: null,
      start: () => () => {},
      destroy: () => {
        destroyed[idx] = 1;
      },
      sendMail: () => Promise.resolve(),
    };
  },
}));

mock.module("../lib/hub-api", () => ({
  launchInstanceSession,
  ensureMeSynced,
  getOutputFeedback: () => Promise.resolve([]),
  saveOutputFeedback: () => Promise.resolve(),
  upsertRating: (prev: unknown) => prev ?? [],
}));

mock.module("../lib/instance-transport", () => ({
  createHubTransport: () => ({}),
}));

mock.module("@workbench/agents/browser", () => ({
  composeChatMessages: () => ({ messages: [] }),
  createToolNameTracker: () => ({ stop: () => {}, names: {} }),
  createLiveTextTracker: () => ({ stop: () => {}, text: "" }),
  createReasoningTracker: () => ({ stop: () => {}, text: "" }),
  createImageTracker: () => ({ stop: () => {}, images: [] }),
}));

const { useMyraSession, deliverMessage } = await import("./use-myra-session");

beforeEach(() => {
  launchInstanceSession.mockClear();
  ensureMeSynced.mockClear();
  destroyed.length = 0;
});

afterEach(() => {
  launchInstanceSession.mockClear();
});

describe("deliverMessage", () => {
  it("relaunches and retries once on a 409, then succeeds", async () => {
    let calls = 0;
    const session = {
      sendMail: mock(() => {
        calls++;
        if (calls === 1) return Promise.reject(new FakeApiError(409));
        return Promise.resolve();
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await deliverMessage(session, "inst-1", "hello");
    expect(session.sendMail).toHaveBeenCalledTimes(2);
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
  });

  it("rethrows a non-409 error without relaunching", async () => {
    const session = {
      sendMail: mock(() => Promise.reject(new FakeApiError(500))),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await expect(
      deliverMessage(session, "inst-1", "hi"),
    ).rejects.toBeInstanceOf(FakeApiError);
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("cannot recover a 409 without an instance id", async () => {
    const session = {
      sendMail: mock(() => Promise.reject(new FakeApiError(409))),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await expect(deliverMessage(session, null, "hi")).rejects.toBeInstanceOf(
      FakeApiError,
    );
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });
});

describe("useMyraSession launch gating (CL-2309 smoothness)", () => {
  it("does not launch while disabled", async () => {
    renderHook(() => useMyraSession("inst-1", false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("does not launch with a null instance id (threads not resolved yet)", async () => {
    renderHook(() => useMyraSession(null, true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("launches exactly once for a concrete instance and never uses the paInstanceId fallback", async () => {
    renderHook(() => useMyraSession("inst-1", true), { wrapper });
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(1));
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).toHaveBeenCalledTimes(1);
  });

  it("tears down the old session and relaunches once when the instance changes", async () => {
    const { rerender } = renderHook(({ id }) => useMyraSession(id, true), {
      initialProps: { id: "inst-1" },
      wrapper,
    });
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(1));
    rerender({ id: "inst-2" });
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(2));
    expect(launchInstanceSession).toHaveBeenLastCalledWith("inst-2");
    expect(destroyed[0]).toBe(1);
  });
});
