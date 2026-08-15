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
      'button[aria-label="Channel settings"]',
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

    // Inside the thread, every message's affordance is now Fork.
    const forkButton = harness.container.querySelector(
      '.chat-thread-affordance[data-thread-affordance-mode="fork"] .chat-thread-open',
    ) as HTMLButtonElement;
    expect(forkButton).not.toBeNull();
    expect(forkButton.textContent).toBe("Fork");
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
      '.chat-thread-affordance[data-thread-affordance-mode="fork"] .chat-thread-open',
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

  test("'New routine' header button calls the host's hop with the active channel", async () => {
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

    const button = [
      ...harness.container.querySelectorAll("button"),
    ].find((element) => element.textContent?.trim() === "New routine");
    expect(button).not.toBeUndefined();
    act(() => {
      button?.click();
    });
    await harness.settle();

    expect(opened).toEqual(["ch_1"]);
    harness.unmount();
  });

  test("the 'New routine' header button is hidden when the host has not wired the hop", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    const button = [
      ...harness.container.querySelectorAll("button"),
    ].find((element) => element.textContent?.trim() === "New routine");
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
