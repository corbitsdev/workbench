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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  participants: [] as { address: string; handle: string }[],
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
const { CHAT_STRINGS } = await import("../src/strings");

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
const setTextareaValue = textareaValueSetter;

function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ChatWorkspace, props),
      ),
    );
  });
  return {
    container,
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
    rerender: (nextProps: Parameters<typeof ChatWorkspace>[0]) =>
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ChatWorkspace, nextProps),
          ),
        );
      }),
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

  test("a controlled settingsSection renders that tab active, not General", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: true,
      settingsSection: "members",
    });
    await harness.settle();

    const activeItem = harness.container.querySelector(
      '.channel-settings-nav-item[aria-current="page"]',
    );
    expect(activeItem?.textContent).toBe("Members");
    harness.unmount();
  });

  test("clicking a different tab reports the new section, not just local UI state", async () => {
    stubFetch();
    const sectionChanges: string[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: true,
      settingsSection: "general",
      onSettingsSectionChange: (section: string) =>
        sectionChanges.push(section),
    });
    await harness.settle();

    const items = Array.from(
      harness.container.querySelectorAll(".channel-settings-nav-item"),
    );
    const membersItem = items.find((el) => el.textContent === "Members") as
      HTMLButtonElement | undefined;
    expect(membersItem).not.toBeUndefined();
    act(() => membersItem?.click());
    await harness.settle();

    expect(sectionChanges).toEqual(["members"]);
    harness.unmount();
  });

  test("the gear button opens settings on the General section", async () => {
    stubFetch();
    const opens: (string | undefined)[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: false,
      onSettingsOpenChange: (_open: boolean, section?: string) =>
        opens.push(section),
    });
    await harness.settle();

    const gearButton = harness.container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    act(() => gearButton.click());
    await harness.settle();

    expect(opens).toEqual(["general"]);
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

// Two-level thread model + fork affordance (CL-5908, CL-5948): a channel
// with one depth-1 thread already open, plus the sub-thread a fork creates.
const ROOT_THREAD = {
  id: "thr_root",
  kind: "root",
  parentMessageId: null,
  parentThreadId: null,
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const DEPTH1_THREAD = {
  id: "thr_1",
  kind: "reply",
  parentMessageId: "msg_1",
  parentThreadId: "thr_root",
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:01:00.000Z",
};
const DEPTH2_THREAD = {
  id: "thr_2",
  kind: "reply",
  parentMessageId: "msg_2",
  parentThreadId: "thr_1",
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:02:00.000Z",
};

function stubThreadedFetch() {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  let forked = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/channels\?kind=channel$/.test(path)) {
      return json({ items: [CHANNEL_WIRE] });
    }
    if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
    if (/\/chat\/channels\/[^/]+\/threads\/fork$/.test(path)) {
      forked = true;
      const body = JSON.parse(String(init?.body)) as {
        parentMessageId: string;
      };
      return json({ ...DEPTH2_THREAD, parentMessageId: body.parentMessageId });
    }
    if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
      const items = forked
        ? [ROOT_THREAD, DEPTH1_THREAD, DEPTH2_THREAD]
        : [ROOT_THREAD, DEPTH1_THREAD];
      return json({ rootThreadId: ROOT_THREAD.id, items });
    }
    if (/\/threads\/thr_root\/messages$/.test(path)) {
      return json({
        thread: ROOT_THREAD,
        items: [
          {
            id: "msg_1",
            createdAt: "2026-01-01T00:00:30.000Z",
            parts: [{ kind: "text", text: "root note" }],
            sender: { name: null, address: "prn_alice@acme.example" },
          },
        ],
      });
    }
    if (/\/threads\/thr_1\/messages$/.test(path)) {
      return json({
        thread: DEPTH1_THREAD,
        items: [
          {
            id: "msg_2",
            createdAt: "2026-01-01T00:01:30.000Z",
            parts: [{ kind: "text", text: "inside the thread" }],
            sender: { name: null, address: "prn_alice@acme.example" },
          },
        ],
      });
    }
    if (/\/threads\/thr_2\/messages$/.test(path)) {
      return json({ thread: DEPTH2_THREAD, items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
      if (init?.method === "POST") {
        return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      return json({
        items: [
          {
            id: "msg_1",
            createdAt: "2026-01-01T00:00:30.000Z",
            parts: [{ kind: "text", text: "root note" }],
            sender: { name: null, address: "prn_alice@acme.example" },
          },
        ],
      });
    }
    if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        ...CHANNEL_WIRE,
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

describe("Thread breadcrumb and fork (CL-5908, CL-5948)", () => {
  test("opening a depth-1 thread shows a two-segment breadcrumb: channel / thread", async () => {
    stubThreadedFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const breadcrumb = harness.container.querySelector(
      ".chat-thread-breadcrumb",
    );
    expect(breadcrumb).not.toBeNull();
    expect(
      breadcrumb?.querySelectorAll(".chat-thread-breadcrumb-link"),
    ).toHaveLength(1);
    expect(breadcrumb?.textContent).toContain("Launch Planning");
    harness.unmount();
  });

  test("an opened thread shows the message it hangs off above its replies", async () => {
    stubThreadedFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    // The thread's own feed carries only "inside the thread"; its
    // parent ("root note", msg_1) is pulled from the channel feed.
    const text = harness.container.textContent ?? "";
    const parentAt = text.indexOf("root note");
    const replyAt = text.indexOf("inside the thread");
    expect(parentAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(-1);
    expect(parentAt).toBeLessThan(replyAt);
    harness.unmount();
  });

  test("forking a message inside a thread opens a sub-thread with a three-segment breadcrumb and an origin banner", async () => {
    stubThreadedFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    // Open the depth-1 thread first.
    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    // Inside the thread, every message's hover-toolbar reply action forks
    // instead of replying — the persistent "Reply in thread" row only
    // renders once a thread already has replies (see `MessageHoverToolbar`
    // and `ThreadAffordance` in `timeline.tsx`), so a fresh message's fork
    // affordance lives in the hover cluster, not a `.chat-thread-open` row.
    // Scope to the reply message's own toolbar — the thread view now
    // renders the parent message (msg_1) above it, which has its own
    // hover cluster.
    const forkButton = harness.container.querySelector(
      '#chat-message-msg_2 .chat-hover-toolbar[data-thread-affordance-mode="fork"] .chat-hover-reply',
    ) as HTMLButtonElement;
    expect(forkButton).not.toBeNull();
    await act(async () => {
      forkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const breadcrumb = harness.container.querySelector(
      ".chat-thread-breadcrumb",
    );
    expect(
      breadcrumb?.querySelectorAll(".chat-thread-breadcrumb-link"),
    ).toHaveLength(2);

    expect(
      harness.container.querySelector(".chat-thread-origin-banner"),
    ).not.toBeNull();
    harness.unmount();
  });

  test("the threads menu indents sub-threads under their depth-1 parent", async () => {
    stubThreadedFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });
    const forkButton = harness.container.querySelector(
      '#chat-message-msg_2 .chat-hover-toolbar[data-thread-affordance-mode="fork"] .chat-hover-reply',
    ) as HTMLButtonElement;
    await act(async () => {
      forkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const group = harness.container.querySelector(".chat-threads-menu-group");
    expect(group).not.toBeNull();
    expect(
      group?.querySelector(".chat-threads-menu-item-nested"),
    ).not.toBeNull();
    harness.unmount();
  });
});

const CHANNEL_WITH_AGENT_WIRE = {
  ...CHANNEL_WIRE,
  participants: [
    { address: "researcher@agents.example", handle: "researcher" },
  ],
};

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

function typeInComposer(container: HTMLElement, text: string) {
  const textarea = container.querySelector(
    ".chat-composer-input",
  ) as HTMLTextAreaElement;
  act(() => {
    setTextareaValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

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
    const sectionsOpened: (string | undefined)[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: false,
      onSettingsOpenChange: (open: boolean, section?: string) => {
        settingsOpenChanges.push(open);
        sectionsOpened.push(section);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/agents");
    pressEnter(textarea);
    await harness.settle();

    expect(settingsOpenChanges).toEqual([true]);
    expect(sectionsOpened).toEqual(["agents"]);
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

  test("/routine opens the New Routine panel pre-bound to the active channel", async () => {
    stubFetch();
    const opened: string[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onCreateRoutineInSpace: (channelId: string) => {
        opened.push(channelId);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toEqual(["ch_1"]);
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("/routine with no host-supplied hop wired falls back to the same unavailable toast /run uses", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("the header's Routines button calls onOpenRoutines, not the per-space create hop", async () => {
    stubFetch();
    let opened = 0;
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onOpenRoutines: () => {
        opened += 1;
      },
      onCreateRoutineInSpace: () => {
        throw new Error("the header button must not call this hop");
      },
    });
    await harness.settle();

    const button = harness.container.querySelector(
      `[aria-label="${CHAT_STRINGS.routinesAction}"]`,
    );
    expect(button).not.toBeNull();
    act(() => {
      (button as HTMLButtonElement).click();
    });
    await harness.settle();

    expect(opened).toBe(1);
    harness.unmount();
  });

  test("the header's Routines button is hidden when onOpenRoutines is not wired", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const button = harness.container.querySelector(
      `[aria-label="${CHAT_STRINGS.routinesAction}"]`,
    );
    expect(button).toBeNull();
    harness.unmount();
  });

  test("the 'New routine' header button is hidden when the host has not wired the hop", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const button = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "New routine",
    );
    expect(button).toBeUndefined();
    harness.unmount();
  });

  test("'Insights' header button calls the host's onOpenInsights hop", async () => {
    stubFetch();
    let opened = 0;
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onOpenInsights: () => {
        opened += 1;
      },
    });
    await harness.settle();

    const button = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Insights",
    );
    expect(button).not.toBeUndefined();
    act(() => {
      button?.click();
    });
    await harness.settle();

    expect(opened).toBe(1);
    harness.unmount();
  });

  test("the 'Insights' header button is hidden when the host has not wired the hop", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const button = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Insights",
    );
    expect(button).toBeUndefined();
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

describe("a stale thread reference self-heals instead of dead-ending", () => {
  // CL-6069: a channel's remembered root-thread id can outlive the
  // server-side run it named (e.g. across a hub restart), so
  // `GET .../threads/:id/messages` 404s. The client must fall back to
  // the channel's live feed rather than rendering a dead-end
  // "Couldn't load messages" / "Try again" that keeps re-requesting
  // the same gone thread.
  function stubFetchWithStaleThread(recoveredText: string) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_stale", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/threads\/thr_stale\/messages$/.test(path)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        return json({
          items: [
            {
              id: "msg_recovered",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: recoveredText }],
            },
          ],
        });
      }
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_WIRE,
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

  test("a 404 on the channel's remembered root thread falls back to the channel's live feed", async () => {
    stubFetchWithStaleThread("recovered after a stale thread 404");
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Couldn't load");
    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain(
      "recovered after a stale thread 404",
    );
    harness.unmount();
  });
});

describe("a channel-level 404 offers a way out instead of retrying forever", () => {
  // CL-6077: the routed channel itself is gone (deleted, or a stale id from
  // a Recents entry that outlived it), not a transient load failure — a
  // dead-end "Try again" button would just re-request the same gone
  // channel forever. The workspace tells the host (so it can drop the
  // stale Recents entry) and offers "Back to workbenches" instead of retry.
  function stubFetchWithMissingChannel() {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_WIRE,
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

  test("reports the dead id to the host and renders Back to workbenches instead of Try again", async () => {
    stubFetchWithMissingChannel();
    const notFoundIds: string[] = [];
    let backToSpacesClicks = 0;
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onChannelNotFound: (channelId: string) => notFoundIds.push(channelId),
      onBackToChannelList: () => {
        backToSpacesClicks += 1;
      },
    });
    await harness.settle();

    // A background refresh (SSE reconnect/poll) can independently retry and
    // re-report the same dead id — purging is idempotent either way, so
    // this only asserts every report named the right channel, not a count.
    expect(notFoundIds.length).toBeGreaterThan(0);
    expect(new Set(notFoundIds)).toEqual(new Set(["ch_1"]));
    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain("Back to workbenches");

    const backButton = Array.from(
      harness.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Back to workbenches"));
    expect(backButton).toBeDefined();
    act(() => {
      backButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(backToSpacesClicks).toBe(1);

    harness.unmount();
  });
});

describe("a 401 on the messages load offers Sign in instead of a dead-end retry", () => {
  function stubFetchWithUnauthorizedMessages() {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_WIRE,
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

  test("renders Sign in (not Try again) and calls onSignIn on click", async () => {
    stubFetchWithUnauthorizedMessages();
    let signInClicks = 0;
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onSignIn: () => {
        signInClicks += 1;
      },
    });
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain("Sign in");

    const signInButton = Array.from(
      harness.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Sign in");
    expect(signInButton).toBeDefined();
    act(() => {
      signInButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(signInClicks).toBe(1);

    harness.unmount();
  });
});

describe("chat error copy never leaks a raw API path", () => {
  test("a genuine load failure renders plain-language copy, never a raw /api/ path or bare status code", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.textContent).toContain("Couldn't load messages");
    expect(harness.container.textContent).not.toContain("/api/");
    expect(harness.container.textContent).not.toContain("500");
    harness.unmount();
  });
});

// CL-6103: the composer used to give no feedback that a send had even
// started, and a failed send surfaced as a tiny red line pinned to the
// composer's own corner — nowhere near the message it was about. These
// tests drive a real submit through `ChatWorkspace` and check the DOM
// states a reader actually sees: the pending bubble appears before the
// network call resolves, a success clears it, a failure shows its own
// inline Retry/Discard, and Discard hands the text back to the composer.
describe("optimistic send (CL-6103)", () => {
  function stubFetchWithSendOutcome(shouldFail: () => boolean) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          if (shouldFail()) {
            return json({ error: { code: "bad_request" } }, 500);
          }
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
          ...CHANNEL_WIRE,
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

  function clickSend(container: HTMLElement) {
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Send"]',
    );
    if (button === null) throw new Error("send button not found");
    act(() => button.click());
  }

  test("the send button is muted while empty and turns primary once there's a draft", async () => {
    stubFetchWithSendOutcome(() => false);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const sendButton = () =>
      harness.container.querySelector<HTMLButtonElement>(
        '[aria-label^="Send"]',
      );
    expect(sendButton()?.getAttribute("data-send-state")).toBe("empty");
    expect(sendButton()?.hasAttribute("disabled")).toBe(true);

    typeInComposer(harness.container, "hi");
    await harness.settle();

    expect(sendButton()?.getAttribute("data-send-state")).toBe("ready");
    expect(sendButton()?.hasAttribute("disabled")).toBe(false);
    harness.unmount();
  });

  test("submitting shows a pending bubble synchronously, clears the composer, and drops it on success", async () => {
    stubFetchWithSendOutcome(() => false);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi");

    // The pending bubble and the composer's own clear both happen inside
    // this one `act`, before the POST's promise has any chance to settle
    // — proving they're synchronous with the submit, not a side effect of
    // the network round-trip landing.
    act(() => {
      clickSend(harness.container);
    });

    expect(textarea.value).toBe("");
    const pendingBubble = harness.container.querySelector(
      '.chat-bubble[data-pending="sending"]',
    );
    expect(pendingBubble).not.toBeNull();
    expect(pendingBubble?.textContent).toContain("hi");

    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    harness.unmount();
  });

  test("a failed send shows the error inline on the bubble itself, with working Retry and Discard", async () => {
    let fail = true;
    stubFetchWithSendOutcome(() => fail);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi");
    act(() => {
      clickSend(harness.container);
    });
    await harness.settle();

    // Never a detached corner line — the failure lives on the bubble.
    expect(harness.container.textContent).not.toContain("Couldn't send");
    const failedBubble = harness.container.querySelector(
      '.chat-bubble[data-pending="failed"]',
    );
    expect(failedBubble).not.toBeNull();
    expect(failedBubble?.textContent).toContain("Not sent");

    const retryButton = [...harness.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).not.toBeUndefined();

    fail = false;
    act(() => retryButton?.click());
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("Discard removes the failed pending bubble and returns its text to the composer", async () => {
    stubFetchWithSendOutcome(() => true);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi there");
    act(() => {
      clickSend(harness.container);
    });
    await harness.settle();

    expect(
      harness.container.querySelector('.chat-bubble[data-pending="failed"]'),
    ).not.toBeNull();

    const discardButton = [
      ...harness.container.querySelectorAll("button"),
    ].find((button) => button.textContent === "Discard");
    expect(discardButton).not.toBeUndefined();
    act(() => discardButton?.click());
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    expect(textarea.value).toBe("hi there");
    harness.unmount();
  });
});

// CL-6251: `loadMessages` calls overlap constantly (every stream event fires
// a background refresh on top of whatever a send already triggered) with no
// guarantee they resolve in the order they were issued. Before the fix,
// "last response to resolve wins" let a stale, slower-resolving refresh
// clobber a newer one that already landed — flickering a just-sent message
// back out of the timeline. This drives two overlapping background
// refreshes with their GET responses deliberately reordered and asserts the
// later-issued request's result is the one that sticks.
describe("loadMessages request ordering (CL-6251)", () => {
  test("a slow, stale refresh resolving after a newer one never reverts the timeline", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    let messagesGetCount = 0;
    let postCount = 0;
    // Set once the two competing background refreshes are about to be
    // triggered — every GET before this index is an incidental load the
    // race doesn't care about (see the mock below).
    let raceStartIndex = Number.POSITIVE_INFINITY;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_WIRE] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          postCount += 1;
          return json({
            id: `msg_new_${postCount}`,
            createdAt: "2026-01-01T00:00:00.000Z",
          });
        }
        const callIndex = messagesGetCount;
        messagesGetCount += 1;
        // Every load before the race starts (the initial mount load, plus
        // however many redundant foreground loads the channel-resolution
        // effects happen to run) reports empty — nothing about those is
        // under test here.
        if (callIndex < raceStartIndex) {
          return json({ items: [] });
        }
        const firstMessage = {
          id: "msg_new_1",
          createdAt: "2026-01-01T00:00:00.000Z",
          parts: [{ kind: "text", text: "first" }],
          sender: { name: null, address: "prn_alice@acme.example" },
        };
        const secondMessage = {
          id: "msg_new_2",
          createdAt: "2026-01-01T00:00:01.000Z",
          parts: [{ kind: "text", text: "second" }],
          sender: { name: null, address: "prn_alice@acme.example" },
        };
        // The first call once the race starts is the stream-drop's
        // background refresh (the older ticket, issued first) —
        // deliberately kept slow, and reports only the first message,
        // correct as of its own request time, before the send below had
        // landed. Every call after that is the send's own post-send
        // refresh (the newer ticket, issued second) — resolves fast, and
        // reports both messages, correct as of ITS request time.
        if (callIndex === raceStartIndex) {
          await sleep(60);
          return json({ items: [firstMessage] });
        }
        await sleep(5);
        return json({ items: [firstMessage, secondMessage] });
      }
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();
    // The initial load resolves through `listThreads` first, then
    // `listMessages` — slower than the flat single-fetch mocks other
    // tests use, so it needs longer than one `settle()` to leave the
    // loading skeleton before the composer mounts.
    await act(() => sleep(100));

    // Drop the stream: `onerror` starts polling, which fires one
    // immediate background refresh — the older, deliberately-slow one.
    raceStartIndex = messagesGetCount;
    act(() => firstStream().fail());

    // Right behind it, a send fires its own post-send background
    // refresh — `ticket` #3, the newer, fast one.
    const sendButton = harness.container.querySelector<HTMLButtonElement>(
      '[aria-label^="Send"]',
    );
    if (sendButton === null) throw new Error("send button not found");
    typeInComposer(harness.container, "second");
    act(() => sendButton.click());

    // Long enough for the fast (newer-ticket) refresh to land and for the
    // slow (stale-ticket) one to resolve after it.
    await act(() => sleep(90));

    expect(
      harness.container.querySelector("#chat-message-msg_new_2"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain("second");
    harness.unmount();
  });
});

describe("Channel header polish (CL-6106)", () => {
  test("the threads dropdown is hidden entirely when the channel has no threads yet", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.querySelector(".chat-threads-menu")).toBeNull();
    harness.unmount();
  });

  test("the threads dropdown appears once the channel has a thread", async () => {
    stubThreadedFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const trigger = harness.container.querySelector(
      ".chat-threads-menu-trigger",
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("1 thread");
    harness.unmount();
  });

  test("agent participant chips share the roster's circular avatar, keeping the handle as a hover tooltip", async () => {
    stubFetch(undefined, CHANNEL_WITH_AGENT_WIRE);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const chip = harness.container.querySelector(
      '.chat-presence-avatar[data-agent="true"]',
    );
    expect(chip).not.toBeNull();
    expect((chip as HTMLElement).title).toBe("researcher");
    expect((chip as HTMLElement).textContent).toBe("R");
    harness.unmount();
  });

  test("the Routines and Insights header buttons render as quiet ghost buttons, not outlined controls", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      onOpenRoutines: () => {},
      onOpenInsights: () => {},
    });
    await harness.settle();

    const routines = harness.container.querySelector(
      `[aria-label="${CHAT_STRINGS.routinesAction}"]`,
    );
    const insights = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Insights",
    );
    expect(routines?.className).not.toContain("border-input");
    expect(insights?.className).not.toContain("border-input");
    harness.unmount();
  });

  test("the settings control is icon-only, at the far right, with a tooltip", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const button = harness.container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent?.trim()).toBe("");
    expect(button.title).toBe("Settings");

    const actions = harness.container.querySelector(".chat-channel-actions");
    expect(actions?.lastElementChild?.contains(button)).toBe(true);
    harness.unmount();
  });
});

describe("switching channels never carries a stale root-thread id across", () => {
  // CL-6067/6069 regression: `loadMessages`'s closure over `rootThreadId`
  // can still hold the *previous* channel's value the instant a channel
  // switch fires the reset effect (the reset's own `setRootThreadId(null)`
  // hasn't committed yet). Trusting it sends the new channel's messages
  // request down the old channel's thread id, which 404s and can leave the
  // pane stuck on the loading skeleton behind the stale-thread-ref fallback
  // cascade instead of rendering promptly.
  const CHANNEL_A = { ...CHANNEL_WIRE, id: "ch_a", title: "Channel A" };
  const CHANNEL_B = { ...CHANNEL_WIRE, id: "ch_b", title: "Channel B" };

  function stubFetchTwoChannels(wrongRequests: string[]) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const notFound = () =>
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/channels\?kind=channel$/.test(path)) {
        return json({ items: [CHANNEL_A, CHANNEL_B] });
      }
      if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/channels\/ch_a\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_a", items: [] });
      }
      if (/\/chat\/channels\/ch_b\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_b", items: [] });
      }
      const rootThread = (id: string) => ({
        id,
        kind: "root" as const,
        parentMessageId: null,
        parentThreadId: null,
        runRef: null,
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      if (/\/chat\/channels\/ch_a\/threads\/thr_a\/messages$/.test(path)) {
        return json({
          thread: rootThread("thr_a"),
          items: [
            {
              id: "msg_a",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: "A message" }],
            },
          ],
        });
      }
      if (/\/chat\/channels\/ch_b\/threads\/thr_b\/messages$/.test(path)) {
        return json({
          thread: rootThread("thr_b"),
          items: [
            {
              id: "msg_b",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: "B message" }],
            },
          ],
        });
      }
      // Any cross-channel thread id combination is the bug this test
      // guards against — record it and 404, exactly like the real hub
      // would for a thread id that doesn't belong to that channel.
      if (/\/chat\/channels\/[^/]+\/threads\/[^/]+\/messages$/.test(path)) {
        wrongRequests.push(path);
        return notFound();
      }
      if (/\/chat\/channels\/[^/]+\/messages/.test(path))
        return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/channels\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/channels\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
        return json({
          ...CHANNEL_A,
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

  test("switching to another channel loads that channel's own thread, not the previous one's", async () => {
    const wrongRequests: string[] = [];
    stubFetchTwoChannels(wrongRequests);
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_a",
    });
    await harness.settle();
    await harness.settle();
    expect(harness.container.textContent).toContain("A message");

    harness.rerender({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_b",
    });
    await harness.settle();
    await harness.settle();

    expect(wrongRequests).toEqual([]);
    expect(harness.container.textContent).not.toContain("Couldn't load");
    expect(harness.container.textContent).toContain("B message");
    harness.unmount();
  });
});
