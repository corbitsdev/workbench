/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as hubClientActual from "@intx/hub-client";
import type { InstanceEvent } from "@intx/hub-client";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const documentFence = [
  "```ui",
  JSON.stringify({
    kind: "document",
    title: "Launch brief",
    source: "# Brief\n\nBody text.",
    actions: { saveArtifact: true },
  }),
  "```",
].join("\n");

const assistantMail = (id: string, content: string): InstanceEvent => ({
  kind: "mail",
  id,
  role: "assistant",
  content,
  sender: { name: "Loop", email: "a@example.com" },
  recipients: [],
  timestamp: "2024-01-01T00:01:00.000Z",
  attachments: [],
});

let sessionEvents: InstanceEvent[] = [];
const mockSendMail = mock(() => Promise.resolve());
const mockCreateInstanceSession = mock(() => ({
  events: sessionEvents,
  streaming: "",
  activity: null,
  hydrated: true,
  start: mock(() => () => undefined),
  sendMail: mockSendMail,
  destroy: mock(() => undefined),
}));

mock.module("@intx/hub-client", () => ({
  ...hubClientActual,
  createInstanceSession: mockCreateInstanceSession,
}));

class NoopEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  close(): void {}
}

let artifactPostCount = 0;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
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
  sessionEvents = [];
  artifactPostCount = 0;
  globalThis.fetch = mock((url: string) => {
    const u = String(url);
    if (u.includes("/sessions")) {
      return Promise.resolve(jsonResponse({ launched: true }));
    }
    if (u.includes("/feedback")) {
      return Promise.resolve(jsonResponse({ ratings: [] }));
    }
    if (u.includes("/artifacts")) {
      artifactPostCount += 1;
      return Promise.resolve(jsonResponse({ error: "boom" }, false, 500));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
  globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  mockSendMail.mockClear();
  mockCreateInstanceSession.mockClear();
});

function renderAgentChat() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat instanceId="ins_123" tenantId="tnt_123" agentName="Loop" />
    </QueryClientProvider>,
  );
}

describe("AgentChat — save-artifact failure path", () => {
  it("shows a failure notice, never a success notice, on a 500", async () => {
    sessionEvents = [assistantMail("m1", documentFence)];
    const view = renderAgentChat();

    const title = await waitFor(() => view.getByText("Launch brief"));
    fireEvent.click(title);
    fireEvent.click(view.getByText("Save to artifacts"));

    await waitFor(() => {
      expect(
        view.getByText("Couldn't save to artifacts. Please try again."),
      ).not.toBeNull();
    });
    expect(view.queryByText(/Saved "/)).toBeNull();
    expect(artifactPostCount).toBe(1);

    // Button remains enabled for retry.
    const saveButton = view.getByText("Save to artifacts") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(artifactPostCount).toBe(2);
    });
  });
});

import { AgentChat } from "./AgentChat";
