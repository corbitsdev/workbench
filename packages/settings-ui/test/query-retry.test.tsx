// CL-6105: settings-ui's sections moved off the retry-less `LoadState` onto
// `@corbits/api-query`'s `APIQuery` + `QueryView`, so a failed section load
// now offers the same Retry affordance every other query in the app does.
// One section (PeopleSection) stands in for every section here — each one
// wires the same `describeQueryError`/retry pattern, so this is a check on
// the shared machinery, not something worth repeating per section.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { PeopleSection } from "../src/people-section";

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
    root.render(<PeopleSection tenantId="tnt_1" />);
  });
  return { container, root };
}

describe("PeopleSection retry", () => {
  test("a failed load shows Retry, and clicking it recovers", async () => {
    let principalsCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) return json(500, {});
        return json(200, {
          data: [
            {
              id: "prn_human_1",
              tenantId: "tnt_1",
              kind: "user",
              refId: "user_1",
              displayName: "Alice Anderson",
              status: "active",
              roles: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
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
      expect(container.textContent).not.toContain("Alice Anderson");

      act(() => {
        retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();

      expect(principalsCalls).toBe(2);
      expect(container.textContent).toContain("Alice Anderson");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a 401 renders sign-in-required, not the generic error state", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/principals") return json(401, {});
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Sign in required");
      expect(
        [...container.querySelectorAll("button")].some(
          (candidate) => candidate.textContent === "Retry",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
