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
        <ContextualPanel path={path} onNavigate={noop} />
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

  test("renders the page and page-specific bands, hides empty pins", () => {
    const markup = renderPanel("/");
    expect(markup).toContain("panel-band-page");
    expect(markup).toContain("panel-band-page-specific");
    // Pins default to empty (no localStorage entries) so the band hides.
    expect(markup).not.toContain("panel-band-pins");
    expect(markup).not.toContain("Pinned");
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
            <ContextualPanel path="/" onNavigate={noop} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("No workbench selected")) break;
    }
    expect(container.innerHTML).toContain("No workbench selected");
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
      const body = path.includes("/top-level-runs")
        ? { data: [], nextCursor: null }
        : { items: [] };
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
            <ContextualPanel path="/" onNavigate={noop} />
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
      "Spaces, chats, and running routines for this workbench will appear here.",
    );
    root.unmount();
    container.remove();
  });

  test("activity band hides entirely once it resolves empty", async () => {
    // The activity band lives on every page (approvals were killed as a
    // route), so it renders at "/". Once the needs-you query resolves empty
    // the whole band — heading included — is omitted per product: no hollow
    // empty-state chrome. Needs a resolved bench so the band can query.
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
      const body = path.includes("/top-level-runs")
        ? { data: [], nextCursor: null }
        : { items: [] };
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
            <ContextualPanel path="/" onNavigate={noop} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    // Let the needs-you query resolve, then settle.
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(container.innerHTML).not.toContain("panel-band-activity");
    expect(container.innerHTML).not.toContain(">Activity<");
    root.unmount();
    container.remove();
  });

  test("activity band renders in the same fixed slot on two different routes", async () => {
    // Regression for the band's position drifting with page-specific content
    // length: it must live in `panel-activity-slot`, a sibling that sits
    // between the scrollable body and the footer dock, on every route — not
    // appended after whatever the page contributes inside the body.
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
    const needsYou = {
      items: [
        {
          id: "appr_1",
          headline: "Write to Firecrawl",
          agentName: "Myra",
          benchName: "Corbits Bench",
          arguments: {},
        },
      ],
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
          new Response(JSON.stringify(needsYou), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const body = path.includes("/top-level-runs")
        ? { data: [], nextCursor: null }
        : { items: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    for (const path of ["/", "/benches"]) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <TestQueryProvider>
            <BenchProvider>
              <ContextualPanel path={path} onNavigate={noop} />
            </BenchProvider>
          </TestQueryProvider>,
        );
      });
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (container.innerHTML.includes("panel-band-activity")) break;
      }

      const slot = container.querySelector(".panel-activity-slot");
      const body = container.querySelector('[data-slot="sidebar-panel-body"]');
      const footer = container.querySelector(
        '[data-slot="sidebar-panel-footer"]',
      );
      expect(slot).not.toBeNull();
      expect(slot?.querySelector(".panel-band-activity")).not.toBeNull();
      // The band is a sibling, not nested inside the scrollable body.
      expect(body?.contains(slot ?? document.body)).toBe(false);
      // Fixed slot sits between the scrollable body and the footer dock.
      const position = slot?.compareDocumentPosition(body ?? document.body);
      const positionFooter = slot?.compareDocumentPosition(
        footer ?? document.body,
      );
      expect((position ?? 0) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(
        (positionFooter ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      root.unmount();
      container.remove();
    }
  });
});
