// CL-6119: notifications was local-draft-only — the choice vanished on
// reload. Covers the real @corbits/preferences wiring: load on mount, save
// on choice, and that the choice survives a reload (a fresh mount against
// the same fake preferences store).
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { NotificationsSection } from "../src/channel-settings/notifications-section";

const TENANT_ID = "tnt_flow";
const CHANNEL_ID = "chn_general";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubPreferencesStore(initial: Record<string, unknown> = {}): {
  data: Record<string, unknown>;
} {
  const state = { data: { ...initial } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path !== `/api/tenants/${TENANT_ID}/preferences`) {
      throw new Error(`unexpected fetch: ${path}`);
    }
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.data = { ...state.data, ...patch };
      return Response.json({ preferences: state.data });
    }
    return Response.json({ preferences: state.data });
  }) as typeof fetch;
  return state;
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NotificationsSection tenantId={TENANT_ID} channelId={CHANNEL_ID} />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

function choiceButton(label: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  ) as HTMLButtonElement | null;
}

describe("NotificationsSection", () => {
  test("loads the stored preference on mount", async () => {
    stubPreferencesStore({ "chat.notifications.chn_general": "mentions" });
    const { container, root } = await mount();
    try {
      const button = choiceButton("Mentions only");
      expect(button?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("defaults to all messages when nothing is stored yet", async () => {
    stubPreferencesStore();
    const { container, root } = await mount();
    try {
      const button = choiceButton("All messages");
      expect(button?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("saves the choice through the preferences PATCH route", async () => {
    const store = stubPreferencesStore();
    const { container, root } = await mount();
    try {
      const mute = choiceButton("Mute");
      await act(async () => {
        mute?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mute?.getAttribute("aria-pressed")).toBe("true");
      expect(store.data["chat.notifications.chn_general"]).toBe("mute");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("persists the choice across a reload", async () => {
    const store = stubPreferencesStore();
    const first = await mount();
    await act(async () => {
      choiceButton("Mentions only")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => first.root.unmount());
    first.container.remove();

    // Same fake store, standing in for a page reload.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      if (path !== `/api/tenants/${TENANT_ID}/preferences`) {
        throw new Error(`unexpected fetch: ${path}`);
      }
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        store.data = { ...store.data, ...patch };
        return Response.json({ preferences: store.data });
      }
      return Response.json({ preferences: store.data });
    }) as typeof fetch;

    const { container, root } = await mount();
    try {
      const button = choiceButton("Mentions only");
      expect(button?.getAttribute("aria-pressed")).toBe("true");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reverts and shows an error when the save fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      if (path !== `/api/tenants/${TENANT_ID}/preferences`) {
        throw new Error(`unexpected fetch: ${path}`);
      }
      if (init?.method === "PATCH") {
        return new Response("nope", { status: 500 });
      }
      return Response.json({ preferences: {} });
    }) as typeof fetch;

    const { container, root } = await mount();
    try {
      const mute = choiceButton("Mute");
      await act(async () => {
        mute?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mute?.getAttribute("aria-pressed")).toBe("false");
      const alert = document.body.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn't save this setting. Try again.");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
