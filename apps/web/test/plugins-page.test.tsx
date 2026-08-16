// Screen-level proof for the Plugins gallery route (CL-6090): real fetch
// wiring through `listPluginsForTenant` (chain-aware credential resolve,
// not the tenant-local list route) and `../skills-api.ts`, rendered
// through `PluginsGallery`. Card/search/tab behavior itself is covered in
// `@corbits/plugins-ui`'s own tests — this proves the page composes real
// data into that component correctly.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { PluginsRoute } from "../src/pages/plugins-page";
import {
  ProviderHealthProvider,
  useRequestPluginsConnect,
} from "../src/shell/provider-health-context";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals")) return Promise.resolve(json(membership));
    if (path.includes("/api/channel-tenancies/kinds"))
      return Promise.resolve(json({ channelTenantIds: [] }));
    if (path.includes("/credentials/resolve/GitHub")) {
      return Promise.resolve(
        json({
          id: "cred_1",
          tenantId: "tnt_1",
          providerId: "prov_1",
          principalId: null,
          oauthClientId: null,
          name: "GitHub",
          type: "api_key",
          description: null,
          scopes: [],
          expiresAt: null,
          status: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path.includes("/connections/provider-health"))
      return Promise.resolve(
        json({ providers: {}, connectedProviderCount: 1 }),
      );
    if (path.includes("/credentials/resolve/")) return Promise.resolve(json(null, 404));
    if (path.includes("/api/tenants/tnt_1/skills"))
      return Promise.resolve(
        json({
          skills: [
            {
              assetId: "skill_1",
              name: "weekly-digest",
              description: "Summarizes the week's channel activity.",
              scope: "tenant",
              creatorPrincipalId: "prn_1",
              updatedAtIso: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );
    return Promise.resolve(json({ data: [], nextCursor: null }));
  }) as typeof fetch;
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <ProviderHealthProvider>
              <PluginsRoute path="/plugins" />
            </ProviderHealthProvider>
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

/** Stands in for `ProviderHealthBanner`'s position as a sibling of the
 * routed page under `ProviderHealthProvider` (CL-6092) — fires the same
 * `requestPluginsConnect` the banner's "Fix it" click does, without
 * pulling in the banner widget itself. */
function DeepLinkProbe({ provider }: { readonly provider: string }) {
  const requestPluginsConnect = useRequestPluginsConnect();
  return (
    <button
      type="button"
      data-testid="probe-request-connect"
      onClick={() => requestPluginsConnect(provider)}
    >
      Request connect
    </button>
  );
}

async function mountWithDeepLink(provider: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <ProviderHealthProvider>
              <DeepLinkProbe provider={provider} />
              <PluginsRoute path="/plugins" />
            </ProviderHealthProvider>
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("PluginsRoute", () => {
  test("resolves plugin status through the chain-aware resolver, not the tenant-local list route", async () => {
    stubFetch();
    const el = await mount();

    expect(el.textContent).toContain("GitHub");
    expect(el.textContent).toContain("Connected here");
  });

  test("mounts the skills gallery with real registry data", async () => {
    stubFetch();
    const el = await mount();

    const skillsTab = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    expect(skillsTab).not.toBeUndefined();
    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.textContent).toContain("weekly-digest");
    expect(el.textContent).toContain("Shared with everyone");
  });

  test("a pending connect deep link (CL-6092) opens that provider's connect panel once the gallery loads", async () => {
    stubFetch();
    const el = await mountWithDeepLink("github");

    // Radix's Dialog portals its content onto `document.body`, outside
    // this test's own `container` — the same reason every other dialog
    // in this app queries `document`, not the render root, once open.
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const probeButton =
      el.querySelector<HTMLButtonElement>('[data-testid="probe-request-connect"]');
    await act(async () => {
      probeButton?.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("GitHub");
  });
});
