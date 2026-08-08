// Column 2 is bench-scoped live activity now, not a page list: it never
// mentions the page routes, and its notifications section is an honest
// empty state — there is no notification feature in the hub yet, so this
// must never render a fabricated sample entry.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { ContextualPanel } from "../src/shell/contextual-panel";

const noop = () => undefined;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderPanel(path: string): string {
  return renderToStaticMarkup(
    <BenchProvider>
      <ContextualPanel path={path} onNavigate={noop} />
    </BenchProvider>,
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

  test("shows an honest empty state once no bench resolves", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(emptyMemberships.clone())) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BenchProvider>
          <ContextualPanel path="/" onNavigate={noop} />
        </BenchProvider>,
      );
    });
    expect(container.innerHTML).toContain("No bench selected");
    root.unmount();
    container.remove();
  });

  test("the notifications section is an honest empty state, never a fabricated entry", async () => {
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
        <BenchProvider>
          <ContextualPanel path="/" onNavigate={noop} />
        </BenchProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain("No notifications yet");
    expect(container.innerHTML).toContain(
      "mentions and mail-backed alerts will land here",
    );
    root.unmount();
    container.remove();
  });
});
