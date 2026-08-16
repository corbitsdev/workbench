// CL-6105: ProfilesSettingsSection moved off a hand-rolled retry-less
// `LoadState` onto `@corbits/api-query`'s `APIQuery` + `QueryView` — a
// failed profiles load now offers the shared Retry affordance, and a 401
// renders as sign-in-required rather than the generic error copy. One
// section stands in for both this package's LoadState consumers
// (ProfilesSettingsSection and ApplyProfilePanel share the same `./api`
// client, so the same fix covers both).

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

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ProfilesSettingsSection tenantId="tnt_1" />);
  });
  return { container, root };
}

describe("ProfilesSettingsSection retry", () => {
  test("a failed load shows Retry, and clicking it recovers", async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/config-profiles") {
        calls += 1;
        if (calls === 1) return json(500, { error: { message: "boom" } });
        return json(200, {
          items: [
            {
              id: "cfp_1",
              name: "Fast & cheap",
              description: null,
              entries: [{ provider: "OpenAI", model: "gpt-5" }],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      const retryButton = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Retry",
      );
      expect(retryButton).not.toBeUndefined();

      act(() => {
        retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();

      expect(calls).toBe(2);
      expect(container.textContent).toContain("Fast & cheap");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a 401 renders sign-in-required, not the generic error state", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/config-profiles") return json(401, {});
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Sign in required");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
