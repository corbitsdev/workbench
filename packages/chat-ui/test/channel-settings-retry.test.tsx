// CL-6105: ChannelSettingsSurface moved off a hand-rolled retry-less state
// onto `@corbits/api-query`'s `APIQuery` + `QueryView` — a failed settings
// load now offers the shared Retry affordance, and a 401 renders as
// sign-in-required rather than the generic error copy. This stands in for
// both this package's LoadState consumers (surface.tsx and
// keys-plugins-section.tsx share the same fetch-and-render pattern).

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ChannelSettingsSurface } from "../src/channel-settings";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof ChannelSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ChannelSettingsSurface, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function baseProps(
  overrides: Partial<Parameters<typeof ChannelSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    channelId: "ch_1",
    channelTitle: "Talk to Myra",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    ...overrides,
  };
}

const settingsFixture = {
  id: "ch_1",
  title: "Talk to Myra",
  kind: "chat",
  pinned: false,
  participants: [],
  settings: {},
  contextWindow: { value: 20, source: "inherit" },
};

describe("ChannelSettingsSurface retry", () => {
  test("a failed load shows Retry, and clicking it recovers", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        calls += 1;
        if (calls === 1) return json({}, 500);
        return json(settingsFixture);
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const el = mount(baseProps());
    await settle();

    const retryButton = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Retry",
    );
    expect(retryButton).not.toBeUndefined();

    act(() => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(calls).toBe(2);
    expect(el.querySelector(".channel-settings-shell")).not.toBeNull();
  });

  test("a 401 renders sign-in-required, not the generic error state", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({}, 401);
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;

    const el = mount(baseProps());
    await settle();

    expect(el.textContent).toContain("Sign in required");
  });
});
