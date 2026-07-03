/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as hubClientActual from "@intx/hub-client";
import type { InstanceEvent } from "@intx/hub-client";

// Interactive-block round-trip (CL-2676): a rendered choice block posts the
// selection back into the session via the same send path typed messages use,
// and document block actions (copy / save-artifact) reach their handlers.
// The Interchange boundary (@intx/hub-client) is mocked; launch + artifact
// HTTP goes through a stubbed fetch.
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const choiceFence = [
  "Pick one:",
  "```ui",
  JSON.stringify({
    kind: "choice",
    prompt: "Which channel?",
    options: [
      { id: "slack", label: "Slack", value: "Post to Slack" },
      { id: "email", label: "Email" },
    ],
  }),
  "```",
].join("\n");

const documentFence = [
  "```ui",
  JSON.stringify({
    kind: "document",
    title: "Launch brief",
    source: "# Brief\n\nBody text.",
    actions: { copy: true, download: true, saveArtifact: true },
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
const mockStart = mock(() => () => undefined);
const mockCreateInstanceSession = mock(() => ({
  events: sessionEvents,
  streaming: "",
  activity: null,
  hydrated: true,
  start: mockStart,
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

let artifactPosts: { url: string; body: unknown }[] = [];
const clipboardWrites: string[] = [];

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
  sessionEvents = [];
  artifactPosts = [];
  clipboardWrites.length = 0;
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/sessions")) {
      return Promise.resolve(jsonResponse({ launched: true }));
    }
    if (u.includes("/feedback")) {
      return Promise.resolve(jsonResponse({ ratings: [] }));
    }
    if (u.includes("/artifacts")) {
      artifactPosts.push({
        url: u,
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return Promise.resolve(
        jsonResponse({
          artifact: {
            id: "art_1",
            tenantId: "tnt_123",
            title: "Launch brief",
            kind: "document",
            status: "draft",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
  globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  mockCreateInstanceSession.mockClear();
  mockStart.mockClear();
  mockSendMail.mockClear();
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

describe("AgentChat — choice block round-trip", () => {
  it("posts the selected option's value as a new turn through sendMail", async () => {
    sessionEvents = [assistantMail("m1", choiceFence)];
    const view = renderAgentChat();

    const slack = await waitFor(() => view.getByText("Slack"));
    fireEvent.click(slack);

    await waitFor(() => {
      expect(mockSendMail).toHaveBeenCalledWith("Post to Slack");
    });
  });

  it("falls back to the option label when the option has no value", async () => {
    sessionEvents = [assistantMail("m1", choiceFence)];
    const view = renderAgentChat();

    const email = await waitFor(() => view.getByText("Email"));
    fireEvent.click(email);

    await waitFor(() => {
      expect(mockSendMail).toHaveBeenCalledWith("Email");
    });
  });
});

describe("AgentChat — document block actions", () => {
  async function openDocument(view: ReturnType<typeof renderAgentChat>) {
    const title = await waitFor(() => view.getByText("Launch brief"));
    fireEvent.click(title);
  }

  it("copies the document source to the clipboard", async () => {
    sessionEvents = [assistantMail("m1", documentFence)];
    const view = renderAgentChat();

    await openDocument(view);
    fireEvent.click(view.getByText("Copy"));

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["# Brief\n\nBody text."]);
    });
  });

  it("saves the document as an artifact via POST /artifacts", async () => {
    sessionEvents = [assistantMail("m1", documentFence)];
    const view = renderAgentChat();

    await openDocument(view);
    fireEvent.click(view.getByText("Save to artifacts"));

    await waitFor(() => {
      expect(artifactPosts.length).toBe(1);
    });
    const post = artifactPosts[0]!;
    expect(post.url).toContain("tenantId=tnt_123");
    expect(post.body).toMatchObject({
      mode: "text",
      title: "Launch brief",
      content: "# Brief\n\nBody text.",
    });
    // Save-artifact must not post a chat turn.
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

import { AgentChat } from "./AgentChat";
