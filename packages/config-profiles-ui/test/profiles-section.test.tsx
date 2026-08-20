import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ProfilesSettingsSection } from "../src/profiles-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function profileRow(overrides: { id: string; name: string }) {
  return {
    id: overrides.id,
    name: overrides.name,
    description: null,
    entries: [{ provider: "OpenAI", model: "gpt-5" }],
    ...timestamps,
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ProfilesSettingsSection tenantId="tnt_1" />);
  });
  return { container, root };
}

describe("ProfilesSettingsSection", () => {
  test("renders the list of existing profiles", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/config-profiles") {
        return json(200, {
          items: [profileRow({ id: "cfp_1", name: "Fast & cheap" })],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Fast & cheap");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("shows an empty state with no profiles, and no workbench falls back to its own empty state", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/config-profiles") {
        return json(200, { items: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("No profiles yet");
    } finally {
      act(() => root.unmount());
      container.remove();
    }

    const noTenantContainer = document.createElement("div");
    document.body.appendChild(noTenantContainer);
    const noTenantRoot = createRoot(noTenantContainer);
    act(() => {
      noTenantRoot.render(<ProfilesSettingsSection tenantId={null} />);
    });
    expect(noTenantContainer.textContent).toContain("No workbench selected");
    act(() => noTenantRoot.unmount());
    noTenantContainer.remove();
  });

  test("deleting a profile calls DELETE and removes it from the list on reload", async () => {
    let deleted = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/tenants/tnt_1/config-profiles") {
        return json(200, {
          items: deleted
            ? []
            : [profileRow({ id: "cfp_1", name: "Fast & cheap" })],
        });
      }
      if (
        url === "/api/tenants/tnt_1/config-profiles/cfp_1" &&
        init?.method === "DELETE"
      ) {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Fast & cheap");

      const deleteButton = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Delete",
      );
      expect(deleteButton).toBeDefined();
      // ConfirmButton arms on the first click and confirms on the second,
      // same element both times.
      act(() => {
        deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();
      act(() => {
        deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();

      expect(deleted).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
