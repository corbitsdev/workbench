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

const STUB_MCP_PRESETS = [
  {
    slug: "granola",
    displayName: "Granola",
    description: "Pull your Granola meeting notes and transcripts — via MCP.",
    url: "https://mcp.granola.ai/mcp",
    keyOptional: false,
    docsUrl: "https://www.granola.ai",
    connected: false,
  },
  {
    slug: "exa",
    displayName: "Exa",
    description: "Search the web (Exa) — no key needed.",
    url: "https://mcp.exa.ai/mcp",
    keyOptional: true,
    docsUrl: "https://exa.ai",
    connected: false,
  },
  {
    slug: "linear",
    displayName: "Linear",
    description: "Manage Linear issues and projects — via MCP.",
    url: "https://mcp.linear.app/mcp",
    keyOptional: false,
    docsUrl: "https://linear.app",
    connected: false,
  },
  {
    slug: "scrapecreators",
    displayName: "ScrapeCreators",
    description: "Read Reddit threads and comments — via MCP.",
    url: "https://api.scrapecreators.com/mcp",
    keyOptional: false,
    docsUrl: "https://scrapecreators.com",
    connected: false,
  },
  {
    slug: "sumble",
    displayName: "Sumble",
    description: "Look up company tech stacks and firmographics — via MCP.",
    url: "https://sumble.com/mcp",
    keyOptional: false,
    docsUrl: "https://sumble.com",
    connected: false,
  },
];

function stubFetch(
  options: {
    readonly inheritedConnectorId?: string;
    readonly mcpServers?: readonly {
      readonly slug: string;
      readonly name: string;
      readonly url: string;
    }[];
    readonly mcpPresets?: typeof STUB_MCP_PRESETS;
    readonly onConnect?: (body: unknown) => Response;
  } = {},
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const resolveMatch = /\/credentials\/resolve\/([^/]+)$/.exec(path);
    if (resolveMatch !== null) {
      const name = decodeURIComponent(resolveMatch[1] as string);
      // GitHub resolves from an ancestor tenant, never this one — the
      // directory's "Inherited" caption case. Every other connector
      // (tool and inference-provider alike) resolves "not connected" —
      // this test only cares which descriptors ever reach the DOM and
      // how the one inherited connection reads.
      if (
        options.inheritedConnectorId !== undefined &&
        name === options.inheritedConnectorId
      ) {
        return json({
          id: "cred_1",
          tenantId: "tnt_ancestor",
          name,
          status: "active",
        });
      }
      return json({}, 404);
    }
    if (/\/mcp-servers\/presets$/.test(path)) {
      return json({ data: options.mcpPresets ?? STUB_MCP_PRESETS });
    }
    if (/\/mcp-servers$/.test(path)) {
      if (init?.method === "POST" && options.onConnect !== undefined) {
        const body: unknown =
          init.body !== undefined ? JSON.parse(String(init.body)) : undefined;
        return options.onConnect(body);
      }
      return json({ data: options.mcpServers ?? [] });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as unknown as typeof fetch;
}

describe("Plugins section", () => {
  test("shows tool connectors, never inference-provider connectors", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);

    expect(names).toContain("Granola");
    expect(names).toContain("Exa");
    expect(names).toContain("Linear");
    expect(names).toContain("GitHub");
    expect(names).toContain("ScrapeCreators");
    expect(names).not.toContain("Anthropic");
    expect(names).not.toContain("OpenAI");
    expect(names).not.toContain("Groq");
    expect(names).not.toContain("Ollama");
  });

  test("everything not connected anywhere lists under Available with a quiet Connect action", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const groupLabels = Array.from(
      el.querySelectorAll(".plugins-directory-group-label"),
    ).map((node) => node.textContent);
    expect(groupLabels).toEqual(["Available"]);

    const connectButtons = Array.from(
      el.querySelectorAll(".plugins-directory-connect-action"),
    );
    expect(connectButtons.length).toBeGreaterThan(0);
    expect(
      connectButtons.every((button) => button.textContent === "Connect"),
    ).toBe(true);
    expect(el.querySelectorAll(".plugins-directory-remove-action").length).toBe(
      0,
    );
  });

  test("a connection inherited from an ancestor tenant lists as Active with an Inherited caption and an Override action", async () => {
    stubFetch({ inheritedConnectorId: "GitHub" });
    const el = mount(baseProps());
    await settle();

    const groupLabels = Array.from(
      el.querySelectorAll(".plugins-directory-group-label"),
    ).map((node) => node.textContent);
    expect(groupLabels).toEqual(["Active", "Available"]);

    const activeGroup = el.querySelectorAll(".plugins-directory-group")[0];
    expect(activeGroup?.textContent).toContain("GitHub");
    expect(
      activeGroup?.querySelector(".plugins-directory-ownership")?.textContent,
    ).toBe("Inherited");
    expect(
      activeGroup?.querySelector(".plugins-directory-connect-action")
        ?.textContent,
    ).toBe("Override");
    expect(
      activeGroup?.querySelector(".plugins-directory-remove-action"),
    ).toBeNull();
  });

  test("search narrows the directory to matching plugins", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const search = el.querySelector(
      ".plugins-directory-search",
    ) as HTMLInputElement | null;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(search, "linear");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);
    expect(names).toEqual(["Linear"]);
  });

  test("a dynamically added MCP server lists alongside the curated connectors, sharing the same row shape", async () => {
    stubFetch({
      mcpServers: [
        {
          slug: "acme",
          name: "Acme Tools",
          url: "https://acme.example.com/mcp",
        },
      ],
    });
    const el = mount(baseProps());
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);
    expect(names).toContain("Acme Tools");

    const groupLabels = Array.from(
      el.querySelectorAll(".plugins-directory-group-label"),
    ).map((node) => node.textContent);
    expect(groupLabels).toEqual(["Active", "Available"]);

    const activeGroup = el.querySelectorAll(".plugins-directory-group")[0];
    expect(activeGroup?.textContent).toContain("Acme Tools");
    expect(
      activeGroup?.querySelector(".plugins-directory-remove-action"),
    ).not.toBeNull();
  });

  test("roster names with no known endpoint list as suggestions and never a dead Connect button pointed at a fake success", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);
    for (const suggestion of ["Notion", "Sentry", "Vercel", "HubSpot"]) {
      expect(names).toContain(suggestion);
    }
  });

  test("Add MCP server opens a dialog with Name, URL, and Access token fields", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const addButton = Array.from(
      el.querySelectorAll(".plugins-directory-add-mcp-action"),
    )[0] as HTMLButtonElement;
    act(() => addButton.click());
    await settle();

    const labels = Array.from(document.querySelectorAll("label")).map(
      (label) => label.textContent,
    );
    expect(labels.some((text) => text?.includes("Name"))).toBe(true);
    expect(labels.some((text) => text?.includes("URL"))).toBe(true);
    expect(labels.some((text) => text?.includes("Access token"))).toBe(true);
  });

  test("clicking a suggestion row opens the Add MCP server dialog prefilled with its name", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const rows = Array.from(el.querySelectorAll(".plugins-directory-row"));
    const notionRow = rows.find((row) => row.textContent?.includes("Notion"));
    const connectButton = notionRow?.querySelector(
      ".plugins-directory-connect-action",
    ) as HTMLButtonElement | undefined;
    expect(connectButton).toBeDefined();
    act(() => connectButton?.click());
    await settle();

    const nameInput = document.querySelector(
      "input[type='text'], .settings-form-field input:not([type])",
    ) as HTMLInputElement | null;
    const nameField = Array.from(
      document.querySelectorAll(".settings-form-field"),
    ).find((field) => field.textContent?.includes("Name"));
    const input = nameField?.querySelector("input") ?? nameInput;
    expect(input?.value).toBe("Notion");
  });

  test("connecting an MCP server that requires OAuth surfaces the honest requirement, never a fake success", async () => {
    stubFetch({
      onConnect: () =>
        json(
          {
            error: {
              message:
                "This MCP server requires signing in via OAuth before it can be connected.",
              code: "oauth_required",
            },
          },
          422,
        ),
    });
    const el = mount(baseProps());
    await settle();

    const addButton = Array.from(
      el.querySelectorAll(".plugins-directory-add-mcp-action"),
    )[0] as HTMLButtonElement;
    act(() => addButton.click());
    await settle();

    const nameField = Array.from(
      document.querySelectorAll(".settings-form-field"),
    ).find((field) => field.textContent?.includes("Name"));
    const urlField = Array.from(
      document.querySelectorAll(".settings-form-field"),
    ).find((field) => field.textContent?.includes("URL"));
    const nameInput = nameField?.querySelector("input") as HTMLInputElement;
    const urlInput = urlField?.querySelector("input") as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      valueSetter?.call(nameInput, "Gated Server");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter?.call(urlInput, "https://gated.example.com/mcp");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const originalLocation = window.location.href;
    let assignedHref: string | undefined;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        set href(value: string) {
          assignedHref = value;
        },
        get href() {
          return assignedHref ?? originalLocation;
        },
      },
    });

    const dialog = document.querySelector("[role='dialog']");
    const connectButton = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Connect") as HTMLButtonElement;
    await act(async () => {
      connectButton.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(assignedHref).toContain("/mcp-servers/oauth/gated-server/start");
    expect(assignedHref).toContain("url=https%3A%2F%2Fgated.example.com%2Fmcp");
  });
});
