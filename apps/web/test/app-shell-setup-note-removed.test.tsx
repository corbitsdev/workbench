// Regression test: the owner's first-run feedback was explicit — the
// "still setting up in the background" note is noise at the exact moment
// someone is forming a first impression, and it must never appear. This
// mounts the real shell with the legacy session flag set (as a stale
// browser tab from before the removal would have it) and asserts the
// note cannot render, proving removal rather than just a hidden default.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AppShell } from "../src/shell/app-shell";
import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const emptyMemberships = () =>
  new Response(JSON.stringify({ data: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// A pending provisioning status is exactly the shape that used to flip the
// note visible once the legacy session flag was set.
const pendingProvisioningStatus = () =>
  new Response(
    JSON.stringify({ kind: "provisioning", setupAgentReady: true }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("app shell no longer shows the background setup note", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia({});
    sessionStorage.setItem("workbench.setup-in-progress", "1");
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      return Promise.resolve(
        url.includes("provisioning-status")
          ? pendingProvisioningStatus()
          : emptyMemberships(),
      );
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.matchMedia = realMatchMedia;
    sessionStorage.clear();
  });

  test("renders no setup note text or markup, even with the legacy flag set", async () => {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <ProviderHealthProvider>
                <ShellChromeProvider path="/inbox" navigate={noop}>
                  <AppShell path="/inbox" user={user} onSignOut={noop}>
                    {"Inbox"}
                  </AppShell>
                </ShellChromeProvider>
              </ProviderHealthProvider>
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle();
    await settle();

    expect(container.textContent).not.toContain("still setting up");
    expect(container.querySelector(".setup-progress-note")).toBeNull();
  });
});
