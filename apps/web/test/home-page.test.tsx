// The land-hop every entry point funnels through: `/` (HomeRoute)
// resolves to one of two places depending on whether the bench has any
// workbenches yet (CL-6104). A bench with one or more ensures Myra's
// channel exists and opens it — the same land-hop CL-6081 wired up.
// A brand-new bench with zero workbenches instead renders the guided
// first-workbench describe screen (see `describe-first-workbench.tsx`)
// rather than auto-creating Myra's channel and stranding the person on
// an "Opening Myra" spinner while that create-a-channel-nobody-asked-for
// happens invisibly. All three entries CL-6081 asks for (a direct visit
// to `/`, `main.tsx`'s post-login `navigate("/")`, and the onboarding
// wizard's post-credential hand-off) resolve through this exact hop, so
// proving HomeRoute itself lands correctly in both cases proves the
// direct-`/` case fully; the other two are proven by the narrower source
// assertions below, which pin the exact call each entry point makes onto
// this same route.

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

function stubFetch(respond: (path: string, method: string) => Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path, init?.method ?? "GET"));
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

const PRINCIPALS_RESPONSE = {
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
};

describe("HomeRoute (the `/` land hop every entry point funnels through)", () => {
  test("a bench with an existing workbench ensures Myra's channel and navigates straight into it", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/channels") && method === "GET") {
        // The all-kinds emptiness check (`listAllChannels`) finds an
        // existing workbench, so the ensure+redirect hop below runs.
        return json({
          items: [
            {
              id: "chan_existing",
              title: "Some workbench",
              kind: "chat",
              pinned: false,
              participants: [],
            },
          ],
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
      if (path.endsWith("/chat/channels") && method === "POST") {
        return json({
          id: "chan_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
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

  test("a brand-new bench with zero workbenches renders the describe screen, never the spinner's auto-create", async () => {
    stubFetch((path, method) => {
      if (path === "/api/me/principals") {
        return json(PRINCIPALS_RESPONSE);
      }
      if (path.endsWith("/chat/channels") && method === "GET") {
        // listAllChannels finds nothing — this bench has no workbenches
        // yet. HomeRoute must stop here, never call ensureMyraChannel.
        return json({ items: [] });
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchProvider>
              <HomeRoute />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle();
    await settle();

    expect(container.textContent).toContain("What should your first agent do?");
    expect(
      container.querySelector("#describe-first-workbench-input"),
    ).not.toBeNull();
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

  test("onboarding hands off to `/` once a working credential is confirmed", () => {
    const source = readFileSync(
      new URL("../src/pages/onboarding-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('navigate("/")');
  });
});
