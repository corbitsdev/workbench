// The "Used by workflows" approximation caveat used to ride a bare `title`
// attribute on a non-interactive <span> — reachable by mouse hover only,
// never announced by a screen reader, never reachable by keyboard or touch.
// It now uses react-ui's InfoTooltip: a focusable trigger button whose note
// is bound via aria-describedby.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ConnectionsSection } from "../src/connections-section";
import { SETTINGS_STRINGS } from "../src/strings";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function mockFetch() {
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/tenants/ten_1/credentials") {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/providers") {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/connections/oauth-configured") {
      return json({});
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("Connections 'Used by workflows' tooltip", () => {
  test("the approximation note is a focusable, keyboard-reachable trigger — not a bare title attribute", async () => {
    mockFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<ConnectionsSection tenantId="ten_1" />);
      });
      await settle();

      // Granola has both feedsTools and pinned workflows in the fixture
      // data, so its card carries the approximation note.
      expect(container.textContent).toContain("Used by workflows:");

      const pinnedSpans = [
        ...container.querySelectorAll(".settings-connection-card-pinned"),
      ];
      for (const span of pinnedSpans) {
        expect(span.getAttribute("title")).toBeNull();
      }

      const trigger = container.querySelector(
        ".settings-connection-card-pinned-row button",
      ) as HTMLButtonElement | null;
      expect(trigger).not.toBeNull();
      expect(trigger?.tagName).toBe("BUTTON");
      expect(trigger?.getAttribute("type")).toBe("button");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("focusing the trigger reveals and associates the approximation note text", async () => {
    mockFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<ConnectionsSection tenantId="ten_1" />);
      });
      await settle();

      const trigger = container.querySelector(
        ".settings-connection-card-pinned-row button",
      ) as HTMLButtonElement;

      act(() => {
        trigger.focus();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const describedBy = trigger.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      const content = document.getElementById(describedBy as string);
      expect(content?.textContent).toBe(
        SETTINGS_STRINGS.connectionsPinnedByApproximationNote,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a connector with feedsTools but no pinned workflows shows the line with no tooltip trigger", async () => {
    mockFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<ConnectionsSection tenantId="ten_1" />);
      });
      await settle();

      // github has feedsTools but an empty pinned-workflows list in the
      // fixture data — "Available to any workflow", no approximation to
      // caveat, so no tooltip trigger should render for that card.
      const cards = [
        ...container.querySelectorAll(".settings-connection-card"),
      ];
      const githubCard = cards.find((card) =>
        card.textContent?.includes("GitHub"),
      );
      expect(githubCard).not.toBeUndefined();
      expect(
        githubCard?.querySelector(
          ".settings-connection-card-pinned-row button",
        ),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
