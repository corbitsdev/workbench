// The owner reported uploading a file with no way to tell it worked. The
// fix must be an honest confirmation: it names the file the server actually
// stored, not the one the browser happened to send, and it stays silent
// (surfacing the failure instead) when the upload endpoint reports one.
// A sibling lane is fixing a real bug where uploaded content reads back
// empty — this suite only pins that the toast is grounded in the upload
// response, never a blind echo of the local `File` picked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { LibraryRoute } from "../src/pages/library-page";
import { spyOnReactUiToast } from "./react-ui-toast-mock";
import { TestQueryProvider } from "./test-query-provider";

const toastMock = spyOnReactUiToast();
const noop = () => undefined;
const realFetch = globalThis.fetch;

const membership = {
  principalId: "prn_1",
  tenantId: "tnt_1",
  tenantName: "Test Bench",
  tenantSlug: "test-bench",
  kind: "user",
  status: "active",
  roles: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function uploadFile(container: HTMLDivElement, file: File): void {
  const input = container.querySelector(
    'input[aria-label="Upload files"]',
  ) as HTMLInputElement | null;
  if (input === null) throw new Error("no upload input");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Files upload confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    toastMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function settle(until: () => boolean): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (until()) return;
    }
  }

  function renderRoute(): void {
    act(() => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <LibraryRoute path="/files" />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
  }

  test("a completed upload confirms the title the server stored, not the local file name", async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/me/principals")) {
        return Promise.resolve(
          jsonResponse({ data: [membership], nextCursor: null }),
        );
      }
      if (url.includes("/artifacts/upload") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "art_new",
                kind: "document",
                // The server renamed it on collision — the confirmation
                // must say this, not the "draft.txt" the browser sent.
                title: "draft (1).txt",
                source: {},
                version: 1,
                ownerPrincipalId: null,
                ownerName: null,
                content: "",
                archivedAt: null,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.includes("/artifacts")) {
        return Promise.resolve(jsonResponse({ data: [], nextCursor: null }));
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch;

    renderRoute();
    await settle(() => container.querySelector('input[type="file"]') !== null);

    uploadFile(container, new File(["hi"], "draft.txt"));
    await settle(() => toastMock.mock.calls.length > 0);

    expect(toastMock).toHaveBeenCalledWith("Uploaded · draft (1).txt");
    expect(container.textContent).not.toContain("draft.txt");
  });

  test("a failed upload surfaces the failure instead of a fake success toast", async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/me/principals")) {
        return Promise.resolve(
          jsonResponse({ data: [membership], nextCursor: null }),
        );
      }
      if (url.includes("/artifacts/upload") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      if (url.includes("/artifacts")) {
        return Promise.resolve(jsonResponse({ data: [], nextCursor: null }));
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch;

    renderRoute();
    await settle(() => container.querySelector('input[type="file"]') !== null);

    uploadFile(container, new File(["hi"], "draft.txt"));
    await settle(() => container.querySelector('[role="alert"]') !== null);

    expect(toastMock).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBeTruthy();
  });
});
