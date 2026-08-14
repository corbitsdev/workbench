// Composition tests for `ChatWorkspace`'s settings-surface wiring: it
// mounts against a registered DOM (see dom-setup.ts) because these prove
// real effect-driven sequencing — the two-step "channels resolve, then the
// settings surface renders" load a direct `/c/:id/settings` URL drives —
// which static markup rendering cannot exercise.
//
// Stubs `global.fetch` the same way test/api.test.ts does (never
// `mock.module`, which would replace `../src/api` for every test file in
// this run, not just this one) and a minimal `EventSource` stand-in so the
// channel stream's connect attempt has something to call.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class StubEventSource {
  static instances: StubEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

const CHANNEL_WIRE = {
  id: "ch_1",
  title: "Launch Planning",
  kind: "channel",
  pinned: false,
  participants: [],
};

const CHANNEL_WITH_AGENT_WIRE = {
  ...CHANNEL_WIRE,
  participants: [
    { address: "researcher@agents.example", handle: "researcher" },
  ],
};

function stubFetch(
  sentMessages?: unknown[],
  channel: typeof CHANNEL_WIRE = CHANNEL_WIRE,
) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/channels\?kind=channel$/.test(path)) {
      return json({ items: [channel] });
    }
    if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
    if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
      if (init?.method === "POST") {
        sentMessages?.push(JSON.parse(String(init.body)));
        return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      return json({ items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        ...channel,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace } = await import("../src/chat-workspace");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no EventSource was opened");
  return instance;
}

const textareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)?.set;
if (textareaValueSetter === undefined) {
  throw new Error("HTMLTextAreaElement.prototype.value has no native setter");
}

function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(ChatWorkspace, props));
  });
  return {
    container,
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
  };
}

describe("ChatWorkspace settings surface", () => {
  test("a direct /c/:id/settings URL renders the settings surface once channels resolve", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: true,
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".channel-settings-stage"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain("Launch Planning");
    harness.unmount();
  });

  test("settingsOpen for a channel id absent from the resolved list falls back to the ordinary chat view and corrects the URL", async () => {
    stubFetch();
    const settingsOpenChanges: boolean[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_missing",
      settingsOpen: true,
      onSettingsOpenChange: (open: boolean) => settingsOpenChanges.push(open),
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".channel-settings-stage"),
    ).toBeNull();
    expect(harness.container.querySelector(".chat-main")).not.toBeNull();
    expect(settingsOpenChanges).toEqual([false]);
    harness.unmount();
  });
});

describe("connection state is never rendered as chrome", () => {
  test("a dropped stream shows no reconnecting banner or status text", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    firstStream().fail();
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-stream-indicator"),
    ).toBeNull();
    expect(harness.container.textContent).not.toContain("Reconnecting");
    harness.unmount();
  });

  test("sending a message succeeds over HTTP while the stream is down", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    // Drop the stream before sending — the send path must not depend on it.
    firstStream().fail();
    await harness.settle();

    const textarea = harness.container.querySelector(
      ".chat-composer-input",
    ) as HTMLTextAreaElement;
    act(() => {
      textareaValueSetter.call(textarea, "hello while down");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = harness.container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      parts: [{ kind: "text", text: "hello while down" }],
    });
    harness.unmount();
  });
});

function typeInComposer(container: HTMLElement, text: string) {
  const textarea = container.querySelector(
    ".chat-composer-input",
  ) as HTMLTextAreaElement;
  act(() => {
    textareaValueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

// Composer's keydown handler reads `event.key`/`.preventDefault` off the
// React SyntheticEvent, which happy-dom's plain `KeyboardEvent` satisfies —
// same construction `refresh-and-send.test.ts`-style suites elsewhere in
// this file already rely on implicitly through user-typed Enter.
describe("composer slash commands — each wired command's real action", () => {
  test("/invite opens the invite-agent dialog", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/invite");
    pressEnter(textarea);
    await harness.settle();

    expect(document.body.textContent).toContain("Invite an agent");
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("/agents opens channel settings straight to the Agents section", async () => {
    stubFetch();
    const settingsOpenChanges: boolean[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: false,
      onSettingsOpenChange: (open: boolean) => settingsOpenChanges.push(open),
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/agents");
    pressEnter(textarea);
    await harness.settle();

    expect(settingsOpenChanges).toEqual([true]);
    harness.unmount();
  });

  test("/run calls the host's routine create/run hop", async () => {
    stubFetch();
    let opened = 0;
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onOpenRoutines: () => {
        opened += 1;
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/run");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toBe(1);
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("/summarize addresses the channel's actual first agent participant and sends", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages, CHANNEL_WITH_AGENT_WIRE);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/summarize");
    pressEnter(textarea);
    await act(() => sleep(30));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      parts: [{ kind: "text", text: "@researcher summarize this thread" }],
    });
    harness.unmount();
  });

  test("/summarize with no agent in the channel never sends a mention it can't back", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages, CHANNEL_WIRE);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/summarize");
    pressEnter(textarea);
    await act(() => sleep(30));

    expect(sentMessages).toHaveLength(0);
    harness.unmount();
  });

  test("/help shows an ephemeral hint listing commands and never sends a message", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/help");
    pressEnter(textarea);
    await harness.settle();

    expect(harness.container.querySelector(".chat-slash-help")).not.toBeNull();
    expect(harness.container.textContent).toContain("Not sent as a message");
    expect(sentMessages).toHaveLength(0);
    harness.unmount();
  });

  test("/thread, /status, and /pin never appear in the popover — no real action behind them today", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    typeInComposer(harness.container, "/");
    await harness.settle();

    const popoverText = harness.container.querySelector(
      ".chat-mention-popover",
    )?.textContent;
    expect(popoverText).not.toBeUndefined();
    expect(popoverText).not.toContain("/thread");
    expect(popoverText).not.toContain("/status");
    expect(popoverText).not.toContain("/pin");
    expect(popoverText).toContain("/invite");
    expect(popoverText).toContain("/summarize");
    expect(popoverText).toContain("/run");
    expect(popoverText).toContain("/agents");
    expect(popoverText).toContain("/help");
    harness.unmount();
  });

  test("an unmatched command's popover offers no items, and typing / at a channel with no agent still opens it", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/zzz");
    await harness.settle();

    expect(harness.container.textContent).toContain("No matching commands");
    expect(textarea.value).toBe("/zzz");
    harness.unmount();
  });
});
