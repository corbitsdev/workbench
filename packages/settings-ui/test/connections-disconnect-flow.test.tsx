// CL-6258: the dead disconnect button. Disconnecting a connector must hit
// the orchestrated `/connections/:id/disconnect` route -- never
// `DELETE /credentials/:id` directly, which 500s for any inference
// provider once a catalog provider row exists against its credential
// (see `@corbits/connections`' `disconnectConnector`). This also covers
// the provider row's new default-model caption, the Models page's
// replacement (CL-6258 item 1).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ConnectionsSection } from "../src/connections-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const STAMP = "2026-01-01T00:00:00.000Z";

const ANTHROPIC_PROVIDER = {
  id: "prv_anthropic",
  tenantId: "ten_1",
  name: "anthropic",
  plugin: "http",
  createdAt: STAMP,
  updatedAt: STAMP,
};

const ANTHROPIC_CREDENTIAL = {
  id: "crd_anthropic",
  tenantId: "ten_1",
  providerId: "prv_anthropic",
  name: "Anthropic",
  type: "api_key" as const,
  status: "active" as const,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const RESOLVED_MODELS = [
  {
    id: "model_1",
    canonicalName: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    offerings: [
      {
        offeringId: "offering_1",
        providerId: "cat_prv_anthropic",
        providerName: "anthropic",
        plugin: "anthropic",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
];

function baseFetch(extra: (url: string) => Response | undefined): typeof fetch {
  return (async (url: string) => {
    const response = extra(url);
    if (response !== undefined) return response;
    if (url === "/api/tenants/ten_1/connections/oauth-configured") {
      return json({});
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function renderSection() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<ConnectionsSection tenantId="ten_1" />);
  });
  return { container, root };
}

describe("Connections disconnect", () => {
  test("shows the connected provider's default model and disconnecting calls the orchestrated route, not a raw credential delete", async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/tenants/ten_1/credentials") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_CREDENTIAL], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/providers") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_PROVIDER], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/connections/oauth-configured") {
        return Promise.resolve(json({}));
      }
      if (url === "/api/tenants/ten_1/models") {
        return Promise.resolve(json(RESOLVED_MODELS));
      }
      if (url === "/api/tenants/ten_1/catalog/offerings") {
        return Promise.resolve(json({ data: [], nextCursor: null }));
      }
      if (url === "/api/tenants/ten_1/connections/anthropic/disconnect") {
        return Promise.resolve(json(undefined, 204));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = renderSection();
    try {
      await settle();

      const defaultModel = container.querySelector(
        'select[aria-label="Default model"]',
      ) as HTMLSelectElement | null;
      expect(defaultModel?.value).toBe("claude-sonnet-5");

      const rows = [...container.querySelectorAll(".settings-connection-row")];
      const anthropicRow = rows.find((row) =>
        row.textContent?.includes("Anthropic"),
      );
      expect(anthropicRow).not.toBeUndefined();
      const disconnectButton = anthropicRow?.querySelector(
        ".settings-connection-row-disconnect-action",
      ) as HTMLButtonElement | null;
      expect(disconnectButton).not.toBeNull();

      // ConfirmButton: arm, then confirm.
      act(() => {
        disconnectButton?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      act(() => {
        disconnectButton?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      await settle();

      const disconnectCall = calls.find((call) =>
        call.url.includes("/disconnect"),
      );
      expect(disconnectCall).toEqual({
        url: "/api/tenants/ten_1/connections/anthropic/disconnect",
        method: "DELETE",
      });
      expect(
        calls.some(
          (call) => call.url === "/api/tenants/ten_1/credentials/crd_anthropic",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a failing disconnect surfaces the inline error, not a silent no-op", async () => {
    globalThis.fetch = baseFetch((url) => {
      if (url === "/api/tenants/ten_1/credentials") {
        return json({ data: [ANTHROPIC_CREDENTIAL], nextCursor: null });
      }
      if (url === "/api/tenants/ten_1/providers") {
        return json({ data: [ANTHROPIC_PROVIDER], nextCursor: null });
      }
      if (url === "/api/tenants/ten_1/models") {
        return json([]);
      }
      if (url === "/api/tenants/ten_1/catalog/offerings") {
        return json({ data: [], nextCursor: null });
      }
      if (url === "/api/tenants/ten_1/connections/anthropic/disconnect") {
        return json(
          {
            error: {
              code: "disconnect_failed",
              userMessage: "nope",
              refId: "ref_1",
            },
          },
          500,
        );
      }
      return undefined;
    });

    const { container, root } = renderSection();
    try {
      await settle();
      const rows = [...container.querySelectorAll(".settings-connection-row")];
      const anthropicRow = rows.find((row) =>
        row.textContent?.includes("Anthropic"),
      );
      const disconnectButton = anthropicRow?.querySelector(
        ".settings-connection-row-disconnect-action",
      ) as HTMLButtonElement | null;

      act(() => {
        disconnectButton?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      act(() => {
        disconnectButton?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      await settle();

      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
