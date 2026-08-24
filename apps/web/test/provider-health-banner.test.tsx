// Integration coverage for CL-6092's shell banner: mounts the real
// `ProviderHealthProvider` above `ProviderHealthBanner` and `PluginsRoute`
// exactly as `app.tsx`'s `Shell` nests them (siblings under one provider,
// same shape `shell-chrome-wiring.test.tsx` proved for canvas state),
// against a stubbed `/connections/provider-health` response — no mocked
// context, so a context-tree wiring mistake would fail this the same way
// it would in the real shell.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import {
  FILES_PATH_PREFIX,
  PLUGINS_PATH_PREFIX,
  SKILLS_PATH_PREFIX,
} from "../src/path-ids";
import { MISSION_CONTROL_PATH, SETTINGS_PATH } from "../src/routes";
import {
  isProviderHealthRecoverySurface,
  ProviderHealthBanner,
} from "../src/shell/provider-health-banner";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// BenchProvider restores its selected tenant from localStorage; a suite that
// ran earlier in the same process may have persisted a tenant this harness's
// membership stub doesn't contain, which silently disables the health query.
beforeEach(() => {
  window.localStorage.clear();
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

function Harness({
  navigate,
  path,
}: {
  readonly navigate: (to: string) => void;
  readonly path: string;
}) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={navigate}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ProviderHealthBanner path={path} />
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

// React Query notifies through timer-batched callbacks, so microtask-only
// flushing races it under full-suite load: yield through real macrotasks
// until the banner (or its absence) settles.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (document.querySelector('[role="alert"]') !== null) return;
  }
}

/** Same flush loop, but waits for a specific `data-provider-health` marker
 * (CL-6834) — used when the chrome settles without an alert (healthy) or
 * with an error marker rather than an unhealthy-provider alert. */
async function flushForHealthMarker(marker: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (document.querySelector(`[data-provider-health="${marker}"]`) !== null) {
      return;
    }
  }
}

function findByText(
  container: HTMLElement,
  text: string,
): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
}

describe("ProviderHealthBanner (CL-6092)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(navigate: (to: string) => void, path = "/w/ch_1") {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root.render(<Harness navigate={navigate} path={path} />);
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("renders fixed guided copy for a credential_failure and links Fix it to Plugins", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          category: "credential_failure",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    const navigated: string[] = [];
    await mount((to) => navigated.push(to));
    await flush();

    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("turned down your key.");

    const fixButton = findByText(container, "Fix it");
    expect(fixButton).not.toBeUndefined();

    await act(async () => {
      fixButton?.click();
    });
    expect(navigated).toEqual(["/plugins"]);
  });

  test("renders fixed guided copy for a quota_exhausted incident", async () => {
    stubFetch({
      providers: {
        openai: {
          status: "needs_attention",
          category: "quota_exhausted",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    await mount(() => undefined);
    await flush();

    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("says this key is out of credit.");
  });

  // CL-6092: the record only ever carries a closed category, so there is
  // no provider prose left to leak through this render layer at all — but
  // this still proves it end to end, from a stubbed HTTP response through
  // to what actually lands in the DOM, in case a future category ever
  // regresses back to interpolating something provider-supplied.
  test("never renders a provider's own raw error text, only the fixed per-category copy", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          category: "credential_failure",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    await mount(() => undefined);
    await flush();

    expect(container.textContent).not.toContain("https://");
    expect(container.textContent).not.toContain("sk-");
  });

  test("routes to onboarding instead of Plugins when there are zero working providers", async () => {
    stubFetch({
      providers: {
        anthropic: {
          status: "needs_attention",
          category: "credential_failure",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 0,
    });
    const navigated: string[] = [];
    await mount((to) => navigated.push(to));
    await flush();

    const fixButton = findByText(container, "Fix it");
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
          category: "credential_failure",
          at: "2026-08-15T00:00:00.000Z",
        },
      },
      connectedProviderCount: 1,
    });
    await mount(() => undefined);
    await flush();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const dismissButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]',
    );
    await act(async () => {
      dismissButton?.click();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("renders nothing when no provider is unhealthy", async () => {
    stubFetch({ providers: {}, connectedProviderCount: 2 });
    await mount(() => undefined);
    await flushForHealthMarker("healthy");

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('[data-provider-health="healthy"]'),
    ).not.toBeNull();
  });

  // CL-6834: a failed first poll used to leave providers at {}, which the
  // chrome treated the same as "ready and nothing unhealthy" — so an
  // unreachable health endpoint looked like every provider was fine.
  test("first-load poll failure shows error chrome, not a silent healthy state", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals"))
        return Promise.resolve(json(membership));
      if (path.includes("/connections/provider-health"))
        return Promise.reject(new Error("network down"));
      return Promise.resolve(json({ items: [] }));
    }) as typeof fetch;

    await mount(() => undefined);
    await flushForHealthMarker("error");

    expect(
      container.querySelector('[data-provider-health="error"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't check provider health");
    // Not the guided unhealthy-provider copy — there is no incident to fix.
    expect(container.textContent).not.toContain("turned down your key.");
    expect(findByText(container, "Fix it")).toBeUndefined();
    expect(
      container.querySelector('[data-provider-health="healthy"]'),
    ).toBeNull();
  });
});

const CREDENTIAL_FAILURE_HEALTH = {
  providers: {
    anthropic: {
      status: "needs_attention" as const,
      category: "credential_failure" as const,
      at: "2026-08-15T00:00:00.000Z",
    },
  },
  connectedProviderCount: 1,
};

describe("isProviderHealthRecoverySurface (CL-6734)", () => {
  test("Skills, Files, Mission Control, and Plugins are not recovery surfaces", () => {
    expect(isProviderHealthRecoverySurface(SKILLS_PATH_PREFIX)).toBe(false);
    expect(
      isProviderHealthRecoverySurface(`${SKILLS_PATH_PREFIX}/drafting`),
    ).toBe(false);
    expect(isProviderHealthRecoverySurface(FILES_PATH_PREFIX)).toBe(false);
    expect(isProviderHealthRecoverySurface(MISSION_CONTROL_PATH)).toBe(false);
    expect(isProviderHealthRecoverySurface(PLUGINS_PATH_PREFIX)).toBe(false);
    expect(
      isProviderHealthRecoverySurface(`${PLUGINS_PATH_PREFIX}/anthropic`),
    ).toBe(false);
  });

  test("Settings and the broken room still are", () => {
    expect(isProviderHealthRecoverySurface(SETTINGS_PATH)).toBe(true);
    expect(isProviderHealthRecoverySurface(`${SETTINGS_PATH}/members`)).toBe(
      true,
    );
    expect(isProviderHealthRecoverySurface("/w/ch_1")).toBe(true);
    expect(isProviderHealthRecoverySurface("/w/ch_1/settings")).toBe(true);
    expect(isProviderHealthRecoverySurface("/")).toBe(true);
  });
});

describe("ProviderHealthBanner scope (CL-6734)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(path: string) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return act(async () => {
      root.render(<Harness navigate={() => undefined} path={path} />);
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("a credential failure is not a sticky toast on Skills, Files, Mission Control, or Plugins", async () => {
    stubFetch(CREDENTIAL_FAILURE_HEALTH);
    await mount(SKILLS_PATH_PREFIX);
    for (const path of [
      SKILLS_PATH_PREFIX,
      FILES_PATH_PREFIX,
      MISSION_CONTROL_PATH,
      PLUGINS_PATH_PREFIX,
    ]) {
      await act(async () => {
        root.render(<Harness navigate={() => undefined} path={path} />);
      });
      await flush();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).not.toContain("turned down your key.");
    }
  });

  test("Settings and the broken room still show the credential failure", async () => {
    stubFetch(CREDENTIAL_FAILURE_HEALTH);
    await mount(SETTINGS_PATH);
    for (const path of [SETTINGS_PATH, "/w/ch_1"]) {
      await act(async () => {
        root.render(<Harness navigate={() => undefined} path={path} />);
      });
      await flush();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain("turned down your key.");
    }
  });

  test("leaving the room for Skills hides the banner; Settings still recovers it", async () => {
    stubFetch(CREDENTIAL_FAILURE_HEALTH);
    await mount("/w/ch_1");
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <Harness navigate={() => undefined} path={SKILLS_PATH_PREFIX} />,
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root.render(<Harness navigate={() => undefined} path={SETTINGS_PATH} />);
    });
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
