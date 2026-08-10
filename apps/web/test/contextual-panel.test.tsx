// Column 2 is the route-aware three-band contextual panel: page band,
// global pins, and page-specific content. It never renders a page-nav list.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { ContextualPanel } from "../src/shell/contextual-panel";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderPanel(path: string): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <BenchProvider>
        <ContextualPanel
          path={path}
          onNavigate={noop}
          onOpenInCanvas={noop}
          canvasOpen={false}
          onToggleCanvas={noop}
          canvasAllowed={false}
        />
      </BenchProvider>
    </TestQueryProvider>,
  );
}

const emptyMemberships = new Response(
  JSON.stringify({ data: [], nextCursor: null }),
  { status: 200, headers: { "content-type": "application/json" } },
);

describe("ContextualPanel", () => {
  test("never renders a page-nav list", () => {
    const markup = renderPanel("/");
    expect(markup).not.toContain("shell-rail-item");
    expect(markup).not.toContain(">Pages<");
  });

  test("renders the three panel bands", () => {
    const markup = renderPanel("/");
    expect(markup).toContain("panel-band-page");
    expect(markup).toContain("panel-band-pins");
    expect(markup).toContain("panel-band-page-specific");
    expect(markup).toContain("Pinned");
  });

  test("shows an honest empty state once no bench resolves", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(emptyMemberships.clone())) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <ContextualPanel
              path="/"
              onNavigate={noop}
              onOpenInCanvas={noop}
              canvasOpen={false}
              onToggleCanvas={noop}
              canvasAllowed={false}
            />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("No bench selected")) break;
    }
    expect(container.innerHTML).toContain("No bench selected");
    root.unmount();
    container.remove();
  });

  test("home live-activity empty state is honest, never a fabricated entry", async () => {
    const membership = {
      data: [
        {
          principalId: "prn_1",
          tenantId: "tnt_1",
          tenantName: "Corbits Bench",
          tenantSlug: "corbits-bench",
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    };
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals")) {
        return Promise.resolve(
          new Response(JSON.stringify(membership), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const body = path.includes("/workflows/instances") ? [] : { items: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <ContextualPanel
              path="/"
              onNavigate={noop}
              onOpenInCanvas={noop}
              canvasOpen={false}
              onToggleCanvas={noop}
              canvasAllowed={false}
            />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("Quiet right now")) break;
    }
    expect(container.innerHTML).toContain("Quiet right now");
    expect(container.innerHTML).toContain(
      "Channels and running routines for this bench will appear here.",
    );
    root.unmount();
    container.remove();
  });

  test("notifications band is global and shows an honest empty state", async () => {
    // The notifications band now lives on every page (approvals were killed
    // as a route), so it renders at "/" — not just on a /approvals page.
    // Needs a resolved bench (memberships) so the band can query needs-you.
    const membership = {
      data: [
        {
          principalId: "prn_1",
          tenantId: "tnt_1",
          tenantName: "Corbits Bench",
          tenantSlug: "corbits-bench",
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    };
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals")) {
        return Promise.resolve(
          new Response(JSON.stringify(membership), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (path.includes("/approvals/needs-you")) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const body = path.includes("/workflows/instances") ? [] : { items: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <ContextualPanel
              path="/"
              onNavigate={noop}
              onOpenInCanvas={noop}
              canvasOpen={false}
              onToggleCanvas={noop}
              canvasAllowed={false}
            />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("No notifications yet")) break;
    }
    expect(container.innerHTML).toContain("No notifications yet");
    expect(container.innerHTML).toContain("Notifications");
    root.unmount();
    container.remove();
  });
});
