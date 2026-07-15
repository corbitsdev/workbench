/// <reference types="bun" />
import "../test-setup";
import { describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { pageContextForPathname } from "../page-context";

const launchInstanceSession = mock(
  (_id: string, _opts?: { pageContext?: string }) =>
    Promise.resolve({ launched: true, sessionId: "ses-1" }),
);

mock.module("@intx/hub-client", () => ({
  ApiError: class extends Error {},
  createInstanceSession: () => ({
    events: [],
    activity: null,
    hydrated: true,
    start: () => () => {},
    destroy: () => {},
    sendMail: () => Promise.resolve(),
  }),
}));

mock.module("../lib/hub-api", () => ({
  launchInstanceSession,
  ensureMeSynced: () =>
    Promise.resolve({
      personalTenantId: "tenant-root",
      credentialResolved: true,
      paInstanceId: "inst-1",
    }),
  abortInstanceTurn: () => Promise.resolve(),
  getOutputFeedback: () => Promise.resolve([]),
  saveOutputFeedback: () => Promise.resolve(),
  upsertRating: (prev: unknown) => prev ?? [],
  getMailAttachmentRefs: () => Promise.resolve([]),
  saveMailAttachmentRefs: () => Promise.resolve(),
}));

mock.module("../lib/instance-transport", () => ({
  createHubTransport: () => ({}),
  fetchBlobObjectUrl: () => Promise.resolve("blob:test"),
  fetchArtifactObjectUrl: () => Promise.resolve("blob:artifact-test"),
}));

mock.module("@workbench/agents/browser", () => ({
  composeChatMessages: () => ({ messages: [] }),
  createPartAssembler: () => ({
    stop: () => {},
    parts: [],
    text: "",
    reasoning: "",
    toolNames: new Map(),
    liveImages: [],
    activity: null,
    closeOpenPart: () => {},
  }),
}));

const { useMyraSession } = await import("./use-myra-session");

function renderAt(pathname: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      React.createElement(QueryClientProvider, { client }, children),
    );
  return renderHook(() => useMyraSession("inst-1", "tnt-acme", true), {
    wrapper,
  });
}

describe("useMyraSession page context (CL-3527)", () => {
  it("sends route pageContext on session launch", async () => {
    launchInstanceSession.mockClear();
    renderAt("/artifacts/art-1");
    await waitFor(() => expect(launchInstanceSession).toHaveBeenCalled());
    expect(launchInstanceSession).toHaveBeenCalledWith("inst-1", {
      pageContext: pageContextForPathname("/artifacts/art-1"),
    });
  });
});
