// CL-6215: the workbench Plugins section carries only tool/plugin
// connections — Granola, Exa, Linear, GitHub, ScrapeCreators, ... —
// never the inference-provider connectors (Anthropic, OpenAI, Groq,
// Ollama, Opencode Zen, ...) that also live in
// `@workbench/connections`'s registry. Those now live only in Shared
// Settings' Connections section. Mounted through `ChannelSettingsSurface`
// itself, the same composition a person actually reaches — stubs
// `global.fetch` directly (every descriptor resolves via
// `GET /credentials/resolve/:name`), never `mock.module`.

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
    section: "plugins" as const,
    ...overrides,
  };
}

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        id: "ch_1",
        title: "Talk to Myra",
        kind: "chat",
        pinned: false,
        participants: [],
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    // Every connector (tool and inference-provider alike) resolves
    // "not connected" — this test only cares which descriptors ever
    // reach the DOM, not their connection status.
    if (/\/credentials\/resolve\//.test(path)) {
      return json({}, 404);
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as unknown as typeof fetch;
}

describe("Plugins section", () => {
  test("shows tool connectors, never inference-provider connectors", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const cardTitles = Array.from(
      el.querySelectorAll(".settings-connection-card-title"),
    ).map((node) => node.textContent);

    expect(cardTitles).toContain("Granola");
    expect(cardTitles).toContain("Exa");
    expect(cardTitles).toContain("Linear");
    expect(cardTitles).toContain("GitHub");
    expect(cardTitles).toContain("ScrapeCreators");
    expect(cardTitles).not.toContain("Anthropic");
    expect(cardTitles).not.toContain("OpenAI");
    expect(cardTitles).not.toContain("Groq");
    expect(cardTitles).not.toContain("Ollama");
  });
});
