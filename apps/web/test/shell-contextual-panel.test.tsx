// The "needs you" count only means anything if it actually reaches the
// screen. After the page list moved onto the rail, the Approvals badge is
// `SidebarRailItem.badge` — not a `SidebarItemRow` `meta` slot on the
// contextual panel. This test renders the real rail tree against a live DOM
// and a mocked hub, so a wrong prop name shows up as a missing count in the
// rendered text, not just a type that happens to check.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { Rail } from "../src/shell/rail";

const noop = () => undefined;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let originalFetch: typeof fetch;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
});

/** Stubs the two hub reads the rail triggers: bench membership (so
 * `BenchProvider` resolves a selected tenant) and this tenant's needs-you
 * list (so the Approvals item has something to badge). */
function stubFetch(needsYouItemCount: number): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/me/principals") {
      return jsonResponse({
        data: [
          {
            principalId: "prn_1",
            tenantId: "tnt_1",
            tenantName: "Growth Team Bench",
            tenantSlug: "growth-team",
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      });
    }
    if (url === "/api/tenants/tnt_1/approvals/needs-you") {
      const items = Array.from({ length: needsYouItemCount }, (_, i) => ({
        id: `apr_${i}`,
        agentName: "Outreach Composer",
        benchName: "Growth Team Bench",
        headline: "send_email",
        arguments: {},
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
      return jsonResponse({ items });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function renderRail(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <Rail
            path="/approvals"
            onNavigate={noop}
            user={user}
            onSignOut={noop}
          />
        </BenchProvider>
      </NavigationProvider>,
    );
    // Two effect-driven fetches run one after the other (membership resolves
    // a tenant id, which is what makes the needs-you effect fire at all), so
    // this waits on a macrotask between each of several microtask turns
    // rather than guessing a fixed microtask count.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  if (container === null) throw new Error("container not mounted");
  return container;
}

describe("Rail's Approvals item", () => {
  test("badges the item with the real pending count once needs-you resolves", async () => {
    stubFetch(3);
    const el = await renderRail();
    expect(el.textContent).toContain("Approvals");
    expect(el.textContent).toContain("3");
  });

  test("carries no badge when nothing is pending", async () => {
    stubFetch(0);
    const el = await renderRail();
    expect(el.textContent).toContain("Approvals");
    // Every other item's label is a bare word with no digits; the absence of
    // any digit anywhere in the rail is the honest way to assert "no badge"
    // without hard-coding the badge's own markup shape.
    expect(el.textContent).not.toMatch(/[0-9]/);
  });
});
