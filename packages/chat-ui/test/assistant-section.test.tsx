// DOM-mounted composition tests for the Assistant settings section: it
// reads and saves through `@corbits/agent-directory`'s routes rather
// than the channel settings PATCH every other section uses, so its
// load/save/error sequencing needs a real effect-driven mount (see
// dom-setup.ts) the same way chat-workspace.test.tsx's settings-surface
// tests do. Stubs `global.fetch` directly, never `mock.module`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ChannelSettingsSurface } from "../src/channel-settings";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const AGENT_PARTICIPANT = { address: "myra@acme.example", handle: "myra" };

function stubFetch(options: {
  readonly participants?: readonly { address: string; handle: string }[];
  readonly name?: string;
  readonly systemPrompt?: string;
  readonly saveFails?: boolean;
  readonly onSave?: (body: { name: string; systemPrompt: string }) => void;
}) {
  const participants = options.participants ?? [AGENT_PARTICIPANT];
  let name = options.name ?? "Myra";
  let systemPrompt = options.systemPrompt ?? "Be a helpful assistant.";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        id: "ch_1",
        title: "Talk to Myra",
        kind: "chat",
        pinned: false,
        participants,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/chat\/channels\/[^/]+\/agent$/.test(path)) {
      const agent = participants.find((p) => p.address.includes("@"));
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no agent in this channel" } },
          404,
        );
      }
      return json({
        address: agent.address,
        handle: agent.handle,
        definitionId: "wfd_myra",
      });
    }
    if (/\/agent-definitions\/wfd_myra$/.test(path)) {
      if (init?.method === "PUT") {
        if (options.saveFails === true) {
          return json({ error: { code: "internal", message: "boom" } }, 500);
        }
        const body = JSON.parse(String(init.body)) as {
          name: string;
          systemPrompt: string;
        };
        name = body.name;
        systemPrompt = body.systemPrompt;
        options.onSave?.(body);
        return json({ name, systemPrompt });
      }
      return json({ name, systemPrompt });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function baseProps(
  overrides: Partial<Parameters<typeof ChannelSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    channelId: "ch_1",
    channelTitle: "Talk to Myra",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    section: "assistant" as const,
    ...overrides,
  };
}

describe("Assistant settings section", () => {
  test("loads the agent's name and instructions and saves them", async () => {
    let saved: { name: string; systemPrompt: string } | undefined;
    stubFetch({
      name: "Myra",
      systemPrompt: "Be a helpful assistant.",
      onSave: (body) => {
        saved = body;
      },
    });
    const el = mount(baseProps());
    await settle();

    const nameInput = el.querySelector(
      ".channel-settings-panel-area input",
    ) as HTMLInputElement | null;
    const textarea = el.querySelector(
      ".channel-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    expect(nameInput?.value).toBe("Myra");
    expect(textarea?.value).toBe("Be a helpful assistant.");

    act(() => {
      textarea?.dispatchEvent(new Event("focus"));
    });
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(textarea, "Be a blunt, no-nonsense assistant.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const saveButton = Array.from(
      el.querySelectorAll(".channel-settings-panel-area button"),
    ).find((button) => button.textContent === "Save") as
      HTMLButtonElement | undefined;
    expect(saveButton).toBeDefined();
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(saved).toEqual({
      name: "Myra",
      systemPrompt: "Be a blunt, no-nonsense assistant.",
    });
    expect(
      (
        Array.from(
          el.querySelectorAll(".channel-settings-panel-area button"),
        ).find((button) => button.textContent === "Save") as
          HTMLButtonElement | undefined
      )?.disabled,
    ).toBe(true);
  });

  test("a failed save shows an inline error and keeps the edit", async () => {
    stubFetch({ saveFails: true });
    const el = mount(baseProps());
    await settle();

    const textarea = el.querySelector(
      ".channel-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(textarea, "Try to save this.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const saveButton = Array.from(
      el.querySelectorAll(".channel-settings-panel-area button"),
    ).find((button) => button.textContent === "Save") as
      HTMLButtonElement | undefined;
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't save these changes — try again.",
    );
    expect(textarea?.value).toBe("Try to save this.");
  });

  test("a channel with no agent participant never shows the Assistant tab", async () => {
    stubFetch({ participants: [] });
    const el = mount(baseProps({ section: "general" }));
    await settle();

    const navLabels = Array.from(
      el.querySelectorAll(".channel-settings-nav-item"),
    ).map((item) => item.textContent);
    expect(navLabels).not.toContain("Assistant");
  });
});
