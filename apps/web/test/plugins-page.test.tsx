// Screen-level proof for the Plugins gallery route (CL-6090): real fetch
// wiring through `listPluginsForTenant` (chain-aware credential resolve,
// not the tenant-local list route) and `../skills-api.ts`, rendered
// through `PluginsGallery`. Card/search/tab behavior itself is covered in
// `@corbits/plugins-ui`'s own tests — this proves the page composes real
// data into that component correctly.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { BenchState } from "../src/bench-context";
import { BenchContext, BenchProvider } from "../src/bench-context";
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
  window.history.replaceState(null, "", "/plugins");
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

function nativeValueSetter(
  proto: HTMLInputElement | HTMLTextAreaElement,
): (this: HTMLInputElement | HTMLTextAreaElement, value: string) => void {
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) {
    throw new Error("native value setter unavailable in this DOM");
  }
  return setter;
}

function fillField(id: string, value: string, textarea = false) {
  const el = document.getElementById(id) as
    HTMLInputElement | HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  if (el === null) return;
  const setter = nativeValueSetter(
    textarea
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
  );
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function stubFetch(
  options: { readonly mcpPresets?: readonly Record<string, unknown>[] } = {},
): void {
  const mcpPresets = options.mcpPresets ?? [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (path.includes("/mcp-servers/presets"))
      return Promise.resolve(json({ data: mcpPresets }));
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/api/workbench-tenancies/kinds"))
      return Promise.resolve(json({ workbenchTenantIds: [] }));
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
    if (path.includes("/credentials/resolve/"))
      return Promise.resolve(json(null, 404));
    if (path.includes("/api/tenants/tnt_1/skills")) {
      if (method === "POST") {
        const parsed =
          init?.body === undefined
            ? {}
            : (JSON.parse(String(init.body)) as { name?: string });
        return Promise.resolve(
          json({
            skill: {
              assetId: "skill_created",
              name: parsed.name ?? "summarize",
              description: "Condenses.",
              scope: "private",
              creatorPrincipalId: "prn_1",
              updatedAtIso: "2026-01-01T00:00:00.000Z",
            },
          }),
        );
      }
      return Promise.resolve(
        json({
          skills: [
            {
              assetId: "skill_1",
              name: "weekly-digest",
              description: "Summarizes the week's workbench activity.",
              scope: "tenant",
              creatorPrincipalId: "prn_1",
              updatedAtIso: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );
    }
    return Promise.resolve(json({ data: [], nextCursor: null }));
  }) as typeof fetch;
}

async function mount(props: { readonly navigate?: (to: string) => void } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <ProviderHealthProvider>
              <PluginsRoute
                path="/plugins"
                navigate={props.navigate ?? (() => undefined)}
              />
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
              <PluginsRoute path="/plugins" navigate={() => undefined} />
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

    expect(
      el.querySelector('button[aria-label="Filter plugins"]'),
    ).not.toBeNull();
    expect(el.textContent).not.toContain("New skill");

    const skillsTab = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    expect(skillsTab).not.toBeUndefined();
    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      el.querySelector('button[aria-label="Filter skills"]'),
    ).not.toBeNull();
    expect(el.textContent).toContain("New skill");
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

    const probeButton = el.querySelector<HTMLButtonElement>(
      '[data-testid="probe-request-connect"]',
    );
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

  // CL-6272.2: a provider connector (OpenRouter, Anthropic, ...) never
  // gets a card on this page at all — providers live only in Shared
  // Settings' Connections section. The OAuth-connect-return-shows-
  // connected assertion this used to cover now lives in
  // `@corbits/settings-ui`'s own Connections suites, the one surface
  // that still offers a provider a Connect button to return from.
  test("a fresh mount never shows a provider connector, even one resolved as connected", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals"))
        return Promise.resolve(json(membership));
      if (path.includes("/api/workbench-tenancies/kinds"))
        return Promise.resolve(json({ workbenchTenantIds: [] }));
      if (path.includes("/credentials/resolve/OpenRouter")) {
        return Promise.resolve(
          json({
            id: "cred_or_1",
            tenantId: "tnt_1",
            name: "OpenRouter",
            status: "active",
          }),
        );
      }
      if (path.includes("/connections/provider-health"))
        return Promise.resolve(
          json({ providers: {}, connectedProviderCount: 1 }),
        );
      if (path.includes("/credentials/resolve/"))
        return Promise.resolve(json(null, 404));
      if (path.includes("/api/tenants/tnt_1/skills"))
        return Promise.resolve(json({ skills: [] }));
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }) as typeof fetch;

    const el = await mount();

    expect(el.textContent).not.toContain("OpenRouter");
  });

  // CL-6092: a deep link naming a provider with no matching gallery card
  // (a stale or misconfigured provider id) used to silently no-op — the
  // gallery should say something instead of nothing.
  test("a pending connect deep link with no matching gallery card renders a visible notice", async () => {
    stubFetch();
    const el = await mountWithDeepLink("not-a-real-connector");

    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const probeButton = el.querySelector<HTMLButtonElement>(
      '[data-testid="probe-request-connect"]',
    );
    await act(async () => {
      probeButton?.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(el.textContent).toContain(
      "Couldn't find that connection — pick it below.",
    );
  });

  test("clicking a skill card navigates to that skill's page", async () => {
    stubFetch();
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });

    const skillsTab = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const card = [...el.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent?.includes("weekly-digest") === true,
    );
    act(() => {
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigated).toContain("/skills/weekly-digest");
  });

  test("Create skill posts to the registry and opens the new skill's page", async () => {
    stubFetch();
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });

    const skillsTab = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const newSkill = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("New skill"),
    );
    await act(async () => {
      newSkill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      fillField("create-skill-name", "summarize");
      fillField("create-skill-description", "Condenses.", true);
      fillField("create-skill-body", "Do it.", true);
    });

    const create = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Create skill",
    );
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(navigated).toContain("/skills/summarize");
  });

  // CL-7138: a fast bench switch used to let the previous tenant's
  // in-flight fetch resolve after the new tenant's, overwriting its data.
  test("a fast bench switch never lets the previous tenant's late fetch overwrite the new one's data", async () => {
    function deferredResponse() {
      let resolve: (response: Response) => void = () => undefined;
      const promise = new Promise<Response>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const skillsDeferred: Record<
      string,
      ReturnType<typeof deferredResponse>
    > = {
      tnt_a: deferredResponse(),
      tnt_b: deferredResponse(),
    };

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/credentials/resolve/"))
        return Promise.resolve(json(null, 404));
      if (path.includes("/connections/provider-health"))
        return Promise.resolve(
          json({ providers: {}, connectedProviderCount: 0 }),
        );
      const skillsMatch = /\/api\/tenants\/(tnt_[ab])\/skills/.exec(path);
      if (skillsMatch) {
        const tenantId = skillsMatch[1] as string;
        return (
          skillsDeferred[tenantId]?.promise ??
          Promise.resolve(json({ skills: [] }))
        );
      }
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }) as typeof fetch;

    let selectTenant: (tenantId: string) => void = () => undefined;

    function BenchHarness({ children }: { readonly children: ReactNode }) {
      const [tenantId, setTenantId] = useState("tnt_a");
      selectTenant = setTenantId;
      const value: BenchState = {
        memberships: { kind: "loading" },
        selectedTenantId: tenantId,
        selectedPrincipalId: "prn_1",
        selectTenant: setTenantId,
        onBenchCreated: () => undefined,
      };
      return (
        <BenchContext.Provider value={value}>{children}</BenchContext.Provider>
      );
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchHarness>
              <ProviderHealthProvider>
                <PluginsRoute path="/plugins" navigate={() => undefined} />
              </ProviderHealthProvider>
            </BenchHarness>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    act(() => {
      selectTenant("tnt_b");
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    skillsDeferred.tnt_b?.resolve(
      json({
        skills: [
          {
            assetId: "skill_b",
            name: "beta-only",
            description: "Tenant B's skill.",
            scope: "tenant",
            creatorPrincipalId: "prn_1",
            updatedAtIso: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    skillsDeferred.tnt_a?.resolve(
      json({
        skills: [
          {
            assetId: "skill_a",
            name: "alpha-only",
            description: "Tenant A's skill.",
            scope: "tenant",
            creatorPrincipalId: "prn_1",
            updatedAtIso: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const skillsTab = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("beta-only");
    expect(container.textContent).not.toContain("alpha-only");
  });

  // CL-7138: cancellation must not turn every imperative reload (a
  // connect/disconnect panel's `onChanged`, the error screen's Retry) into
  // a full teardown to the loading skeleton — only a genuine tenant change
  // should do that. This drives the real disconnect flow end to end.
  test("disconnecting a plugin reloads without tearing the gallery down to the loading skeleton", async () => {
    let deferCredentialResolves = false;
    const deferredResolvers: (() => void)[] = [];
    const githubCredential = {
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
    };

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && path.includes("/credentials/cred_1"))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (path.includes("/api/me/principals"))
        return Promise.resolve(json(membership));
      if (path.includes("/api/workbench-tenancies/kinds"))
        return Promise.resolve(json({ workbenchTenantIds: [] }));
      if (path.includes("/credentials/resolve/GitHub")) {
        if (deferCredentialResolves) {
          return new Promise<Response>((resolve) => {
            deferredResolvers.push(() => resolve(json(null, 404)));
          });
        }
        return Promise.resolve(json(githubCredential));
      }
      if (path.includes("/connections/provider-health"))
        return Promise.resolve(
          json({ providers: {}, connectedProviderCount: 1 }),
        );
      if (path.includes("/credentials/resolve/"))
        return Promise.resolve(json(null, 404));
      if (path.includes("/api/tenants/tnt_1/skills"))
        return Promise.resolve(json({ skills: [] }));
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }) as typeof fetch;

    const el = await mount();
    expect(el.textContent).toContain("Connected here");

    const manageButton = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage GitHub"]',
    );
    await act(async () => {
      manageButton?.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const disconnectButton = () =>
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Disconnect") === true,
      );
    expect(disconnectButton()).not.toBeUndefined();

    // From here on, the reload the disconnect triggers must not resolve
    // until we say so — gives us a window to inspect the mid-reload DOM.
    deferCredentialResolves = true;

    // First click arms the confirm button, second click fires the delete.
    await act(async () => {
      disconnectButton()?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      disconnectButton()?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // The delete resolved and `onChanged` fired `reloadPlugins`; its fetch
    // is now the deferred one above, still pending.
    expect(el.textContent).not.toContain("Loading plugins…");
    expect(el.textContent).toContain("GitHub");

    deferredResolvers.forEach((resolve) => resolve());
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(el.textContent).not.toContain("Connected here");
  });

  // CL-7141: `request_connection`'s fallback link (`/plugins?connect=<id>`)
  // hands off through the same `requestPluginsConnect` path the shell
  // banner's "Fix it" click uses.
  test("a `?connect=<id>` URL naming a known connector opens that connector's connect panel", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/plugins?connect=github");

    const el = await mount();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("GitHub");
    expect(window.location.search).toBe("");
    expect(el).not.toBeNull();
  });

  // CL-7141: an id the registry doesn't recognize (typo, stale link) is
  // ignored — no dialog, no "couldn't find that connection" notice.
  test("a `?connect=<id>` URL naming an unknown connector is ignored", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/plugins?connect=bogus");

    const el = await mount();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(el.textContent).not.toContain(
      "Couldn't find that connection — pick it below.",
    );
    expect(window.location.search).toBe("");
  });

  // CL-7141: `?connect=<id>` strips only the `connect` param — any other
  // query param this route was opened with must survive.
  test("a `?connect=<id>` URL keeps every other query param", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/plugins?foo=bar&connect=github");

    await mount();

    expect(window.location.search).toBe("?foo=bar");
  });

  // CL-7141: `presetDeepLink` in `packages/connections-tools/src/tool.ts`
  // emits `/plugins?connect=mcp:<slug>` for a curated MCP preset (Exa,
  // Granola, Linear, ...) — this page resolves that against the preset
  // catalog and focuses the matching card's own Connect button once it
  // has loaded, rather than matching it against `CONNECTOR_REGISTRY`
  // (which has no entry for a preset's `mcp:<slug>` id).
  test("a `?connect=mcp:<slug>` URL naming a known preset focuses that preset's connect button", async () => {
    stubFetch({
      mcpPresets: [
        {
          slug: "exa",
          displayName: "Exa",
          description: "Search and research the live web.",
          url: "https://mcp.exa.ai/mcp",
          connectionMode: "keyless",
          docsUrl: "https://docs.exa.ai/reference/exa-mcp",
          connected: false,
        },
      ],
    });
    window.history.replaceState(null, "", "/plugins?connect=mcp:exa");

    const el = await mount();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const connectButton = el.querySelector(
      '[data-plugin-slug="exa"] button[aria-label="Connect Exa"]',
    );
    expect(connectButton).not.toBeNull();
    expect(document.activeElement).toBe(connectButton);
    expect(window.location.search).toBe("");
  });

  // CL-7141: a preset slug the catalog doesn't recognize (typo, stale
  // link) is ignored — no dialog, no notice, no thrown error.
  test("a `?connect=mcp:<slug>` URL naming an unknown preset is ignored", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/plugins?connect=mcp:bogus");

    const el = await mount();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(el.textContent).not.toContain(
      "Couldn't find that connection — pick it below.",
    );
    expect(window.location.search).toBe("");
  });
});
