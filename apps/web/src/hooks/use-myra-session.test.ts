/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
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
const sessionStops: ReturnType<typeof mock>[] = [];
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
    const stop = mock();
    sessionStops.push(stop);
    return {
      events: [],
      activity: null,
      start: () => stop,
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

let capturedOnStreamError: ((err: Error) => void) | null = null;

mock.module("../lib/instance-transport", () => ({
  createHubTransport: (opts?: { onStreamError?: (err: Error) => void }) => {
    capturedOnStreamError = opts?.onStreamError ?? null;
    return {};
  },
  fetchBlobObjectUrl: (_tenantId: string, _blobId: string) =>
    Promise.resolve("blob:test"),
}));

const trackerStops = {
  toolNames: mock(),
  liveText: mock(),
  reasoning: mock(),
  image: mock(),
};

mock.module("@workbench/agents/browser", () => ({
  composeChatMessages: () => ({ messages: [] }),
  createToolNameTracker: () => ({ stop: trackerStops.toolNames, names: {} }),
  createLiveTextTracker: () => ({ stop: trackerStops.liveText, text: "" }),
  createReasoningTracker: () => ({ stop: trackerStops.reasoning, text: "" }),
  createImageTracker: () => ({ stop: trackerStops.image, images: [] }),
}));

const {
  useMyraSession,
  deliverMessage,
  deliverMessageWithAttachments,
  attachmentErrorMessage,
  composeWithDocumentContext,
  parseDocumentAttachment,
  DocumentParseError,
} = await import("./use-myra-session");

type DeliverTransport = Parameters<typeof deliverMessageWithAttachments>[0];

beforeEach(() => {
  launchInstanceSession.mockClear();
  ensureMeSynced.mockClear();
  destroyed.length = 0;
  sessionTenantIds.length = 0;
  sessionStops.length = 0;
  capturedOnStreamError = null;
  trackerStops.toolNames.mockClear();
  trackerStops.liveText.mockClear();
  trackerStops.reasoning.mockClear();
  trackerStops.image.mockClear();
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

  it("relaunches and retries once on a 502, then succeeds", async () => {
    let calls = 0;
    const session = {
      sendMail: mock(() => {
        calls++;
        if (calls === 1) return Promise.reject(new FakeApiError(502));
        return Promise.resolve();
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await deliverMessage(session, "inst-1", "hello");
    expect(session.sendMail).toHaveBeenCalledTimes(2);
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
  });

  it("surfaces a second consecutive 502 instead of relaunching again", async () => {
    const session = {
      sendMail: mock(() => Promise.reject(new FakeApiError(502))),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await expect(
      deliverMessage(session, "inst-1", "hi"),
    ).rejects.toBeInstanceOf(FakeApiError);
    expect(session.sendMail).toHaveBeenCalledTimes(2);
    expect(launchInstanceSession).toHaveBeenCalledTimes(1);
  });

  it("relaunches on a 502 carrying the structured sidecar_unavailable code", async () => {
    let calls = 0;
    const session = {
      sendMail: mock(() => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new FakeApiError(502, "sidecar_unavailable"));
        }
        return Promise.resolve();
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await deliverMessage(session, "inst-1", "hello");
    expect(session.sendMail).toHaveBeenCalledTimes(2);
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1");
  });

  it("does not relaunch a true gateway 502 carrying an unrelated structured code", async () => {
    const session = {
      sendMail: mock(() =>
        Promise.reject(new FakeApiError(502, "upstream_gateway_error")),
      ),
      // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    } as any;
    await expect(
      deliverMessage(session, "inst-1", "hi"),
    ).rejects.toBeInstanceOf(FakeApiError);
    expect(session.sendMail).toHaveBeenCalledTimes(1);
    expect(launchInstanceSession).not.toHaveBeenCalled();
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

  // CL-3155: identityKey (derived from instanceId/tenantId) must never be
  // committed alongside the previous identity's stale `ready` phase. The
  // render-time reset means the very commit that carries the new instanceId
  // already carries `phase: "loading"` — there is no intermediate commit a
  // consumer (e.g. useReportConnectionStatus) could observe with the old
  // `ready` still attached to the new identity.
  it("commits phase as loading in the same update as an identity change, never a stale ready", async () => {
    const { rerender, result } = renderHook(
      ({ id }: { id: string }) => useMyraSession(id, "tnt-acme", true),
      {
        initialProps: { id: "inst-1" },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));

    rerender({ id: "inst-2" });

    expect(result.current.state.phase).toBe("loading");
  });
});

describe("useMyraSession — terminal stream error teardown (CL-3211)", () => {
  it("stops every sibling tracker subscription, not just the session, on a terminal stream error", async () => {
    renderHook(() => useMyraSession("inst-1", "tnt-acme", true), { wrapper });
    await waitFor(() => expect(sessionStops).toHaveLength(1));
    await waitFor(() => expect(capturedOnStreamError).not.toBeNull());

    await act(async () => {
      capturedOnStreamError?.(new Error("gave up reconnecting"));
      await Promise.resolve();
    });

    expect(sessionStops[0]).toHaveBeenCalled();
    expect(trackerStops.toolNames).toHaveBeenCalled();
    expect(trackerStops.liveText).toHaveBeenCalled();
    expect(trackerStops.reasoning).toHaveBeenCalled();
    expect(trackerStops.image).toHaveBeenCalled();
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

  it("relaunches and retries once on a 502", async () => {
    let calls = 0;
    const fetchMock = mock((_m: string, _p: string, _b: unknown) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new FakeApiError(502));
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

  it("surfaces a second consecutive 502 instead of relaunching again", async () => {
    const fetchMock = mock((_m: string, _p: string, _b: unknown) =>
      Promise.reject(new FakeApiError(502)),
    );
    const transport = {
      fetch: fetchMock,
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    await expect(
      deliverMessageWithAttachments(
        transport,
        "tnt-acme",
        "inst-1",
        "hi",
        attachments,
      ),
    ).rejects.toBeInstanceOf(FakeApiError);
    expect(launchInstanceSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("relaunches on a 502 carrying the structured sidecar_unavailable code", async () => {
    let calls = 0;
    const fetchMock = mock((_m: string, _p: string, _b: unknown) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new FakeApiError(502, "sidecar_unavailable"));
      }
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

  it("does not relaunch a true gateway 502 carrying an unrelated structured code", async () => {
    const fetchMock = mock((_m: string, _p: string, _b: unknown) =>
      Promise.reject(new FakeApiError(502, "upstream_gateway_error")),
    );
    const transport = {
      fetch: fetchMock,
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    await expect(
      deliverMessageWithAttachments(
        transport,
        "tnt-acme",
        "inst-1",
        "hi",
        attachments,
      ),
    ).rejects.toBeInstanceOf(FakeApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(launchInstanceSession).not.toHaveBeenCalled();
  });
});

describe("document diversion (CL-2628)", () => {
  it("POSTs a document to the parse route, not the mail route", async () => {
    const fetchMock = mock((_m: string, _p: string, _b: unknown) =>
      Promise.resolve({
        artifactId: "art_1",
        filename: "report.pdf",
        parsedText: "the parsed text",
      }),
    );
    const transport = {
      fetch: fetchMock,
      subscribe: () => () => {},
    } as unknown as DeliverTransport;

    const doc = await parseDocumentAttachment(transport, "inst-1", {
      filename: "report.pdf",
      mimeType: "application/pdf",
      data: "BASE64",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]).toBe(
      "/api/v1/instances/inst-1/parse-file",
    );
    expect(doc.parsedText).toBe("the parsed text");
  });

  it("rejects a malformed parse response instead of trusting it", async () => {
    const transport = {
      fetch: mock(() => Promise.resolve({ artifactId: "art_1" })),
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    const err = await parseDocumentAttachment(transport, "inst-1", {
      filename: "x.pdf",
      mimeType: "application/pdf",
      data: "AAAA",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentParseError);
  });

  it("folds parsed document text into a leading context block ahead of the user's message", () => {
    const composed = composeWithDocumentContext("what does this say?", [
      { artifactId: "art_1", filename: "report.pdf", parsedText: "PDF BODY" },
    ]);
    expect(composed).toBe(
      "<context>\n[Attached document: report.pdf]\nPDF BODY\n</context>\n\nwhat does this say?",
    );
  });

  it("returns the message unchanged when there are no documents", () => {
    expect(composeWithDocumentContext("hello", [])).toBe("hello");
  });

  it("maps a parse-route timeout (504) to a clear, non-connectivity message", async () => {
    const transport = {
      fetch: mock(() => Promise.reject(new FakeApiError(504))),
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    const err = await parseDocumentAttachment(transport, "inst-1", {
      filename: "big.pdf",
      mimeType: "application/pdf",
      data: "AAAA",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentParseError);
    expect(attachmentErrorMessage(err)).toContain("too long");
    // Not the generic connectivity fallback.
    expect(attachmentErrorMessage(err)).not.toContain("connection");
  });

  it("maps a parse-route 502 to a connection failure, not a content failure", async () => {
    const transport = {
      fetch: mock(() => Promise.reject(new FakeApiError(502))),
      subscribe: () => () => {},
    } as unknown as DeliverTransport;
    const err = await parseDocumentAttachment(transport, "inst-1", {
      filename: "big.pdf",
      mimeType: "application/pdf",
      data: "AAAA",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentParseError);
    expect(attachmentErrorMessage(err)).toContain("connect");
    // Not the generic content-failure message.
    expect(attachmentErrorMessage(err)).not.toContain("couldn't be read");
  });

  it("surfaces a DocumentParseError's message rather than a connectivity error", () => {
    expect(
      attachmentErrorMessage(
        new DocumentParseError("That document couldn't be read."),
      ),
    ).toBe("That document couldn't be read.");
  });
});
