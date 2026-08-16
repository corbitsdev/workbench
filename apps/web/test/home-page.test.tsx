// The land-hop every entry point funnels through: `/` (HomeRoute) ensures
// Myra's channel exists and opens it — see `../src/pages/home-page.tsx`'s
// module doc. All three entries CL-6081 asks for (a direct visit to `/`,
// `main.tsx`'s post-login `navigate("/")`, and the onboarding wizard's
// "Meet Myra" button) resolve through this exact hop, so proving HomeRoute
// itself lands in Myra's chat proves the direct-`/` case fully; the other
// two are proven by the narrower source assertions below, which pin the
// exact call each entry point makes onto that same route.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { HomeRoute } from "../src/pages/home-page";
import { resetMyraChannelCache } from "../src/myra-channel";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetMyraChannelCache();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(respond: (path: string) => Response) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path));
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

describe("HomeRoute (the `/` land hop every entry point funnels through)", () => {
  test("a resolved bench ensures Myra's channel and navigates straight into it", async () => {
    stubFetch((path) => {
      if (path === "/api/me/principals") {
        return json({
          data: [
            {
              principalId: "prn_1",
              tenantId: "tnt_1",
              tenantName: "Growth Team",
              tenantSlug: "growth-team",
              kind: "user",
              status: "active",
              roles: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/channels?kind=channel")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/channels?kind=chat")) {
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tnt_1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/channels")) {
        return json({
          id: "chan_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={(to) => navigated.push(to)}>
            <BenchProvider>
              <HomeRoute />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/c/chan_myra"]);
  });
});

describe("the other two entries land on the same `/` hop", () => {
  test("signing in navigates to `/`, not a dashboard of its own", () => {
    const source = readFileSync(
      new URL("../src/main.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/handleSignedIn[\s\S]*?navigate\("\/"\)/);
  });

  test("onboarding's Meet Myra button navigates to `/`", () => {
    const source = readFileSync(
      new URL("../src/pages/onboarding-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('<Button onClick={() => navigate("/")}>Meet Myra</Button>');
  });
});
