// InferenceSection's own fetch/render wiring: a resolved catalog with a
// tied-priority own row pair reorders into a distinct order (the
// reorder-tie regression this section exists to fix), a restricted
// offering is labeled by model/provider name rather than its raw
// offering id (raw-id sweep, sibling to
// packages/settings-ui/test/raw-id-sweep.test.tsx), and a move button
// with no legal neighbor renders disabled with an explanatory title
// rather than silently doing nothing on click.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { InferenceSection } from "../src/inference-section";

const TENANT_ID = "tnt_1";
const NOW = "2026-01-01T00:00:00.000Z";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : new URL(String(input)).pathname;
}

const modelInfo = {
  id: "model_1",
  canonicalName: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  offerings: [
    {
      offeringId: "offering_a",
      providerId: "mp_a",
      providerName: "First key",
      plugin: "anthropic",
      priority: 0,
      deploymentTags: [],
      capabilities: [],
      pricing: [],
    },
    {
      offeringId: "offering_b",
      providerId: "mp_b",
      providerName: "Second key",
      plugin: "anthropic",
      priority: 0,
      deploymentTags: [],
      capabilities: [],
      pricing: [],
    },
  ],
};

const restrictedOffering = {
  id: "offering_restricted",
  tenantId: TENANT_ID,
  modelId: "model_1",
  providerId: "mp_a",
  priority: 0,
  deploymentTags: [],
  capabilities: [],
  quirks: null,
  disabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function paginated(data: readonly unknown[]) {
  return { data, nextCursor: null };
}

function stubReadRoutes(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = pathOf(input);
    if (path === `/api/tenants/${TENANT_ID}/models`) {
      return Response.json([modelInfo]);
    }
    if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
      return Response.json(
        paginated([
          {
            id: "offering_a",
            tenantId: TENANT_ID,
            modelId: "model_1",
            providerId: "mp_a",
            priority: 0,
            deploymentTags: [],
            capabilities: [],
            quirks: null,
            disabled: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: "offering_b",
            tenantId: TENANT_ID,
            modelId: "model_1",
            providerId: "mp_b",
            priority: 0,
            deploymentTags: [],
            capabilities: [],
            quirks: null,
            disabled: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          restrictedOffering,
        ]),
      );
    }
    if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
      return Response.json(
        paginated([
          {
            id: "model_1",
            tenantId: TENANT_ID,
            canonicalName: "claude-sonnet-5",
            displayName: "Claude Sonnet 5",
            disabled: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]),
      );
    }
    if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
      return Response.json(
        paginated([
          {
            id: "mp_a",
            tenantId: TENANT_ID,
            name: "First key",
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "cred_a",
            disabled: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]),
      );
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<InferenceSection tenantId={TENANT_ID} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe("InferenceSection", () => {
  test("labels a restricted offering by model and provider name, never its raw offering id", async () => {
    stubReadRoutes();
    const { container, root } = await mount();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Claude Sonnet 5");
      expect(text).toContain("First key");
      expect(text).not.toContain("offering_restricted");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("renders the fallback list as a table, not a raw div grid", async () => {
    stubReadRoutes();
    const { container, root } = await mount();
    try {
      expect(container.querySelector("table")).not.toBeNull();
      expect(container.querySelector(".settings-connections-grid")).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("disables 'Move up' on the first row with an explanatory title, not a silent no-op", async () => {
    stubReadRoutes();
    const { container, root } = await mount();
    try {
      const buttons = Array.from(container.querySelectorAll("button"));
      const moveUp = buttons.find((b) => b.textContent === "Move up");
      expect(moveUp).toBeDefined();
      expect(moveUp?.disabled).toBe(true);
      expect(moveUp?.getAttribute("title")).toBeTruthy();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reordering two tied-priority own rows sends distinct priorities, not a no-op swap", async () => {
    const patchedPriorities: number[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (
        method === "PATCH" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/catalog/offerings/`)
      ) {
        const body = JSON.parse(String(init?.body)) as { priority: number };
        patchedPriorities.push(body.priority);
        return Response.json({
          id: path.split("/").pop(),
          tenantId: TENANT_ID,
          modelId: "model_1",
          providerId: "mp_a",
          priority: body.priority,
          deploymentTags: [],
          capabilities: [],
          quirks: null,
          disabled: false,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      if (path === `/api/tenants/${TENANT_ID}/models`) {
        return Response.json([modelInfo]);
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/offerings`) {
        return Response.json(
          paginated([
            {
              id: "offering_a",
              tenantId: TENANT_ID,
              modelId: "model_1",
              providerId: "mp_a",
              priority: 0,
              deploymentTags: [],
              capabilities: [],
              quirks: null,
              disabled: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "offering_b",
              tenantId: TENANT_ID,
              modelId: "model_1",
              providerId: "mp_b",
              priority: 0,
              deploymentTags: [],
              capabilities: [],
              quirks: null,
              disabled: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ]),
        );
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/models`) {
        return Response.json(paginated([]));
      }
      if (path === `/api/tenants/${TENANT_ID}/catalog/providers`) {
        return Response.json(paginated([]));
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as typeof fetch;

    const { container, root } = await mount();
    try {
      const buttons = Array.from(container.querySelectorAll("button"));
      const moveDown = buttons.find(
        (b) => b.textContent === "Move down" && !b.disabled,
      );
      expect(moveDown).toBeDefined();
      await act(async () => {
        moveDown?.dispatchEvent(
          new Event("click", { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(patchedPriorities.length).toBeGreaterThanOrEqual(2);
      expect(patchedPriorities[0]).not.toBe(patchedPriorities[1]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
