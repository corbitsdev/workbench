// CL-6015: a chat artifact chip's "Open in Files" affordance navigates to
// `/files/a/:id` — this is the Files side of that deep link, proving
// the route lands on the right artifact already selected, without any
// extra click.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { LibraryRoute } from "../src/pages/library-page";
import { TestQueryProvider } from "./test-query-provider";

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

const listedArtifact = {
  id: "art_1",
  kind: "document",
  title: "Q3 report",
  source: { origin: "workflow", runId: "run_42" },
  version: 1,
  ownerPrincipalId: null,
  ownerName: null,
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/api/me/principals")) {
    return Promise.resolve(
      jsonResponse({ data: [membership], nextCursor: null }),
    );
  }
  if (url.includes("/artifacts/art_1")) {
    return Promise.resolve(
      jsonResponse({ ...listedArtifact, content: "# Q3\nGrowth is up." }),
    );
  }
  if (url.includes("/artifacts")) {
    return Promise.resolve(
      jsonResponse({ data: [listedArtifact], nextCursor: null }),
    );
  }
  return Promise.reject(new Error(`unrouted fetch in library test: ${url}`));
}

describe("Files deep link", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function settle(until: (html: string) => boolean): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (until(container.innerHTML)) return;
    }
  }

  test("navigating to /files/a/:id lands with that artifact already selected", async () => {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <LibraryRoute path="/files/a/art_1" />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle((html) => html.includes("Growth is up"));

    expect(container.innerHTML).toContain("Q3 report");
    expect(container.innerHTML).toContain("Growth is up");
    const selectedRow = container.querySelector('[data-state="selected"]');
    expect(selectedRow?.textContent).toContain("Q3 report");
  });

  test("the preview shows a workflow-run provenance link for a workflow-produced artifact", async () => {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <LibraryRoute path="/files/a/art_1" />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle((html) => html.includes("Produced by workflow run"));

    const link = container.querySelector('a[href="/insights/runs/run_42"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Produced by workflow run");
  });
});
