import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ApplyProfilePanel } from "../src/apply-profile-panel";

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

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ApplyProfilePanel tenantId="tnt_1" />);
  });
  return { container, root };
}

describe("ApplyProfilePanel", () => {
  test("lists profiles, shows a preview for the selection, and applies on click", async () => {
    const calls: { method: string; url: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      if (url === "/api/tenants/tnt_1/config-profiles") {
        return json(200, {
          items: [
            {
              id: "cfp_1",
              name: "Fast & cheap",
              description: null,
              entries: [
                { provider: "OpenAI", model: "gpt-5" },
                { provider: "Anthropic", model: "claude" },
              ],
              ...timestamps,
            },
          ],
        });
      }
      if (url === "/api/tenants/tnt_1/config-profiles/apply") {
        return json(200, {
          profileId: "cfp_1",
          profileName: "Fast & cheap",
          results: [
            {
              provider: "OpenAI",
              model: "gpt-5",
              action: "reordered",
              offeringId: "ofr_1",
              priority: 0,
              disabled: false,
            },
            {
              provider: "Anthropic",
              model: "claude",
              action: "skipped-inherited",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Fast & cheap");

      const select = container.querySelector("select");
      expect(select).not.toBeNull();
      act(() => {
        (select as HTMLSelectElement).value = "cfp_1";
        select?.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
      expect(container.textContent).toContain("2 providers");

      const applyButton = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Apply",
      );
      expect(applyButton).toBeDefined();
      act(() => {
        applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();

      expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true);
      expect(container.textContent).toContain("1 set");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("shows an empty state when there are no profiles", async () => {
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
      expect(container.querySelector("select")).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
