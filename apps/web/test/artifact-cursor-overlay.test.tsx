// The canvas artifact pane's co-viewer cursor overlay (CL-5958): rendered
// only when `presenceCursors` has entries, positioned in the pane's own
// fractional coordinate space, and `onCursorMove` fires with fractional
// coordinates as the pointer moves — mirrors canvas-column.test.tsx's own
// mount harness.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("../src/profile-relations", () => ({
  ensureProfileDm: mock(() =>
    Promise.resolve({ kind: "ready", workbenchId: "chn_dm" }),
  ),
  loadSharedWorkbenches: mock(() => Promise.resolve([])),
}));

const { BenchProvider } = await import("../src/bench-context");
const { NavigationProvider } = await import("../src/navigation");
const { CanvasColumn } = await import("../src/shell/canvas-column");
const { TestQueryProvider } = await import("./test-query-provider");

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
  if (url.includes("/api/workbench-tenancies/kinds")) {
    return Promise.resolve(jsonResponse({ workbenchTenantIds: [] }));
  }
  return Promise.reject(
    new Error(`unrouted fetch in cursor overlay test: ${url}`),
  );
}

const artifact = {
  id: "art_1",
  title: "Design doc",
  rendererKind: "doc" as const,
  content: "# hello",
};

describe("canvas artifact co-viewer cursor overlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(props: {
    presenceCursors?: Parameters<typeof CanvasColumn>[0]["presenceCursors"];
    onCursorMove?: (x: number, y: number) => void;
  }) {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <CanvasColumn
                open
                profile={null}
                artifact={artifact}
                routine={null}
                focus={false}
                onClose={noop}
                onToggleFocus={noop}
                onNavigate={noop}
                {...(props.presenceCursors !== undefined
                  ? { presenceCursors: props.presenceCursors }
                  : {})}
                {...(props.onCursorMove !== undefined
                  ? { onCursorMove: props.onCursorMove }
                  : {})}
              />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  });

  test("no overlay renders when there are no co-viewers", () => {
    render({});
    expect(container.querySelector(".shell-artifact-cursor-layer")).toBeNull();
  });

  test("one labeled cursor per co-viewer, positioned by fractional coordinates", () => {
    render({
      presenceCursors: [
        {
          principalId: "prn_alice",
          displayName: "Alice",
          color: "hsl(10 65% 45%)",
          x: 0.25,
          y: 0.5,
        },
      ],
    });

    const cursor = container.querySelector(
      ".shell-artifact-cursor",
    ) as HTMLElement | null;
    expect(cursor).not.toBeNull();
    expect(cursor?.style.left).toBe("25%");
    expect(cursor?.style.top).toBe("50%");
    expect(
      container.querySelector(".shell-artifact-cursor-label")?.textContent,
    ).toBe("Alice");
  });

  test("pointer movement over the artifact body reports fractional coordinates", () => {
    const moves: [number, number][] = [];
    render({ onCursorMove: (x, y) => moves.push([x, y]) });

    const body = container.querySelector(
      ".shell-artifact-pane-body",
    ) as HTMLElement;
    expect(body).not.toBeNull();
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;

    act(() => {
      body.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 50,
          clientY: 25,
          bubbles: true,
        }),
      );
    });

    expect(moves).toEqual([[0.25, 0.25]]);
  });
});
