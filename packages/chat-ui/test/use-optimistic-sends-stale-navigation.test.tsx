// CL-7198: a send continuation captures the workbench id at send time and
// used to re-open its freshly-created reply thread even after the reader
// had already switched to a different workbench — see
// `use-optimistic-sends.ts`'s `openThreadById` call. This mounts the real
// hook against a DOM (see dom-setup.ts) and a stubbed `fetch` (never
// `mock.module`, per test/chat-workspace.test.tsx's own note) so the
// continuation's timing is real, not simulated.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useOptimisticSends } from "../src/use-optimistic-sends";
import type { ComposerSendPayload } from "../src/composer";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type PendingResponse = {
  readonly resolve: (body: unknown) => void;
};

function stubFetch(): { readonly nextSend: () => PendingResponse } {
  const queue: ((body: unknown) => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    if (init?.method === "POST" && /\/messages$/.test(path)) {
      return new Promise<Response>((resolve) => {
        queue.push((body: unknown) => {
          resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        });
      });
    }
    if (init?.method === "POST" && /\/presence$/.test(path)) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
  return {
    nextSend: () => {
      const resolve = queue.shift();
      if (resolve === undefined) throw new Error("no send in flight");
      return { resolve };
    },
  };
}

function mount(initialWorkbenchId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient();
  const root = createRoot(container);
  const openThreadCalls: string[] = [];
  let setWorkbenchId: (id: string) => void = () => undefined;
  let handleSend: (payload: ComposerSendPayload) => Promise<boolean> = () =>
    Promise.resolve(false);

  function Host() {
    const [workbenchId, updateWorkbenchId] = useState(initialWorkbenchId);
    setWorkbenchId = updateWorkbenchId;
    const optimistic = useOptimisticSends({
      tenantId: "ten_1",
      activeWorkbenchId: workbenchId,
      currentUserPrincipalId: "prn_self",
      openThreadId: null,
      pendingParentMessageId: "msg_parent",
      openThreadById: (threadId: string) => {
        openThreadCalls.push(threadId);
      },
      noteAwaitingReply: () => undefined,
      hasAgentParticipant: false,
      restoreDraft: () => undefined,
    });
    handleSend = optimistic.handleSend;
    return null;
  }

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Host),
      ),
    );
  });

  return {
    send: (payload: ComposerSendPayload) => {
      let result: Promise<boolean> = Promise.resolve(false);
      act(() => {
        result = handleSend(payload);
      });
      return result;
    },
    switchWorkbench: (id: string) =>
      act(() => {
        setWorkbenchId(id);
      }),
    openThreadCalls: () => openThreadCalls,
    settle: () => act(() => Promise.resolve().then(() => Promise.resolve())),
    unmount: () => act(() => root.unmount()),
  };
}

describe("useOptimisticSends — stale thread navigation (CL-7198)", () => {
  test("a send continuation no-ops its navigation once the reader has switched to a different workbench", async () => {
    const { nextSend } = stubFetch();
    const harness = mount("ch_a");

    const sendPromise = harness.send({ text: "hello", attachments: [] });
    const inFlight = nextSend();

    harness.switchWorkbench("ch_b");

    await act(async () => {
      inFlight.resolve({
        id: "msg_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: "thr_1",
        clientId: "pending_1",
      });
      await sendPromise;
    });

    expect(harness.openThreadCalls()).toEqual([]);
    harness.unmount();
  });

  test("a send continuation still navigates when the reader is on the same workbench once it resolves", async () => {
    const { nextSend } = stubFetch();
    const harness = mount("ch_a");

    const sendPromise = harness.send({ text: "hello", attachments: [] });
    const inFlight = nextSend();

    await act(async () => {
      inFlight.resolve({
        id: "msg_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: "thr_1",
        clientId: "pending_1",
      });
      await sendPromise;
    });

    expect(harness.openThreadCalls()).toEqual(["thr_1"]);
    harness.unmount();
  });

  test("switching away and back to the same workbench before the send resolves still navigates", async () => {
    const { nextSend } = stubFetch();
    const harness = mount("ch_a");

    const sendPromise = harness.send({ text: "hello", attachments: [] });
    const inFlight = nextSend();

    harness.switchWorkbench("ch_b");
    harness.switchWorkbench("ch_a");

    await act(async () => {
      inFlight.resolve({
        id: "msg_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: "thr_1",
        clientId: "pending_1",
      });
      await sendPromise;
    });

    // The reader is back on the workbench the send targeted, so the thread
    // it created is exactly what they'd expect to see — this is a
    // deliberate outcome of comparing against the *current* workbench,
    // not stale detection of "did anything change in between".
    expect(harness.openThreadCalls()).toEqual(["thr_1"]);
    harness.unmount();
  });
});
