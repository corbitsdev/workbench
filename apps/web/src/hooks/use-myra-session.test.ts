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
  code?: string;
  constructor(status: number, code?: string) {
    super("api error");
    this.status = status;
    this.code = code;
  }
}

const destroyed: number[] = [];
const sessionTenantIds: (string | undefined)[] = [];
const launchInstanceSession = mock((_id: string) =>
  Promise.resolve({ launched: true }),
);
const ensureMeSynced = mock(() =>
  Promise.resolve({
    personalTenantId: "tenant-root",
    credentialResolved: true,
    paInstanceId: "fallback-should-not-be-used",
  }),
);

mock.module("@intx/hub-client", () => ({
  ApiError: FakeApiError,
  createInstanceSession: (opts: { tenantId?: string }) => {
    const idx = destroyed.length;
    destroyed.push(0);
    sessionTenantIds.push(opts?.tenantId);
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
  fetchBlobObjectUrl: (_tenantId: string, _blobId: string) =>
    Promise.resolve("blob:test"),
}));

mock.module("@workbench/agents/browser", () => ({
  composeChatMessages: () => ({ messages: [] }),
  createToolNameTracker: () => ({ stop: () => {}, names: {} }),
  createLiveTextTracker: () => ({ stop: () => {}, text: "" }),
  createReasoningTracker: () => ({ stop: () => {}, text: "" }),
  createImageTracker: () => ({ stop: () => {}, images: [] }),
}));

const {
  useMyraSession,
  deliverMessage,
  deliverMessageWithAttachments,
  attachmentErrorMessage,
} = await import("./use-myra-session");

type DeliverTransport = Parameters<typeof deliverMessageWithAttachments>[0];

beforeEach(() => {
  launchInstanceSession.mockClear();
  ensureMeSynced.mockClear();
  destroyed.length = 0;
  sessionTenantIds.length = 0;
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
    renderHook(() => useMyraSession("inst-1", "tnt-acme", false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("does not launch with a null instance id (threads not resolved yet)", async () => {
    renderHook(() => useMyraSession(null, "tnt-acme", true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("does not launch without an active workbench tenant", async () => {
    renderHook(() => useMyraSession("inst-1", null, true), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });

  it("launches exactly once for a concrete instance and never uses the paInstanceId fallback", async () => {
    renderHook(() => useMyraSession("inst-1", "tnt-acme", true), { wrapper });
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(1));
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(launchInstanceSession).toHaveBeenCalledTimes(1);
  });

  it("opens the session against the active workbench tenant, not the working/root tenant", async () => {
    renderHook(() => useMyraSession("inst-1", "tnt-acme", true), { wrapper });
    await waitFor(() => expect(sessionTenantIds).toHaveLength(1));
    // The instance lives in the active workbench (tnt-acme); the session must
    // connect there, not the working/global-org tenant (tenant-root).
    expect(sessionTenantIds[0]).toBe("tnt-acme");
  });

  it("tears down the old session and relaunches once when the instance changes", async () => {
    const { rerender } = renderHook(
      ({ id }) => useMyraSession(id, "tnt-acme", true),
      {
        initialProps: { id: "inst-1" },
        wrapper,
      },
    );
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(1));
    rerender({ id: "inst-2" });
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalledTimes(2));
    expect(launchInstanceSession).toHaveBeenLastCalledWith("inst-2");
    expect(destroyed[0]).toBe(1);
  });
});

describe("attachmentErrorMessage", () => {
  it("maps oversize codes to plain-language limits", () => {
    expect(
      attachmentErrorMessage(new FakeApiError(413, "oversize_attachment")),
    ).toContain("10 MB");
    expect(
      attachmentErrorMessage(new FakeApiError(413, "oversize_total")),
    ).toContain("30 MB");
  });

  it("maps a disallowed type to a readable message", () => {
    expect(
      attachmentErrorMessage(new FakeApiError(415, "disallowed_mime_type")),
    ).toContain("cannot read");
  });

  it("maps the server per-agent rejection to a readable message", () => {
    expect(
      attachmentErrorMessage(new FakeApiError(422, "disallowed_for_agent")),
    ).toContain("can't read");
  });

  it("falls back to a connection message for a non-API error", () => {
    expect(attachmentErrorMessage(new Error("boom"))).toContain("connection");
  });
});

describe("deliverMessageWithAttachments", () => {
  const attachments = [{ mimeType: "image/png", data: "AAAA", name: "a.png" }];

  it("POSTs content and attachments to the instance mail route", async () => {
    const fetchMock = mock((_m: string, _p: string, _b: unknown) =>
      Promise.resolve(undefined),
    );
    const transport = {
      fetch: fetchMock,
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    await deliverMessageWithAttachments(
      transport,
      "tnt-acme",
      "inst-1",
      "hi",
      attachments,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]).toBe(
      "/api/tenants/tnt-acme/agents/instances/inst-1/mail",
    );
    expect(fetchMock.mock.calls[0]?.[2]).toEqual({
      content: "hi",
      attachments,
    });
  });

  it("relaunches and retries once on a 409", async () => {
    let calls = 0;
    const fetchMock = mock((_m: string, _p: string, _b: unknown) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new FakeApiError(409));
      return Promise.resolve(undefined);
    });
    const transport = {
      fetch: fetchMock,
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    await deliverMessageWithAttachments(
      transport,
      "tnt-acme",
      "inst-1",
      "hi",
      attachments,
    );
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
