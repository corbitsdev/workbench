// Integration coverage for CL-6092's shell banner: mounts the real
// `ProviderHealthProvider` above `ProviderHealthBanner` and `PluginsRoute`
// exactly as `app.tsx`'s `Shell` nests them (siblings under one provider,
// same shape `shell-chrome-wiring.test.tsx` proved for canvas state),
// against a stubbed `/connections/provider-health` response — no mocked
// context, so a context-tree wiring mistake would fail this the same way
// it would in the real shell.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { ProviderHealthBanner } from "../src/shell/provider-health-banner";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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

function stubFetch(providerHealthBody: unknown): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/connections/provider-health"))
      return Promise.resolve(json(providerHealthBody));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function Harness({ navigate }: { readonly navigate: (to: string) => void }) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={navigate}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ProviderHealthBanner />
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("ProviderHealthBanner (CL-6092)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(navigate: (to: string) => void) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root.render(<Harness navigate={navigate} />);
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("renders the provider's own reason and links Fix it to Plugins", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          reason: "the key was rejected",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    const navigated: string[] = [];
    await mount((to) => navigated.push(to));
    await flush();

    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("the key was rejected");

    const fixButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Fix it",
    );
    expect(fixButton).not.toBeUndefined();

    await act(async () => {
      fixButton?.click();
    });
    expect(navigated).toEqual(["/plugins"]);
  });

  test("routes to onboarding instead of Plugins when there are zero working providers", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          reason: "the key was rejected",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 0,
    });
    const navigated: string[] = [];
    await mount((to) => navigated.push(to));
    await flush();

    const fixButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Fix it",
    );
    await act(async () => {
      fixButton?.click();
    });
    expect(navigated).toEqual(["/onboarding"]);
  });

  test("dismissing hides the banner", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          reason: "the key was rejected",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    await mount(() => undefined);
    await flush();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const dismissButton = container.querySelector<HTMLButtonElement>(
      ".provider-health-banner-dismiss",
    );
    await act(async () => {
      dismissButton?.click();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("renders nothing when no provider is unhealthy", async () => {
    stubFetch({ providers: {}, connectedProviderCount: 2 });
    await mount(() => undefined);
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
