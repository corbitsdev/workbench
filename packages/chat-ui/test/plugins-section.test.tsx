// CL-6215: the workbench Plugins section carries only tool/plugin
// connections — Granola, Exa, Linear, and other verified MCP presets —
// never the inference-provider connectors (Anthropic, OpenAI, Groq,
// Ollama, Opencode Zen, ...) that also live in
// `@workbench/connections`'s registry. Those now live only in Shared
// Settings' Connections section. Mounted through `WorkbenchSettingsSurface`
// itself, the same composition a person actually reaches — stubs
// `global.fetch` directly (every descriptor resolves via
// `GET /credentials/resolve/:name`), never `mock.module`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchSettingsSurface } from "../src/workbench-settings";

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

function mount(props: Parameters<typeof WorkbenchSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(WorkbenchSettingsSurface, props));
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
  overrides: Partial<Parameters<typeof WorkbenchSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    workbenchId: "ch_1",
    workbenchTitle: "Talk to Myra",
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
    connectionMode: "oauth",
    docsUrl: "https://www.granola.ai",
    connected: false,
  },
  {
    slug: "exa",
    displayName: "Exa",
    description: "Search the web (Exa) — no key needed.",
    url: "https://mcp.exa.ai/mcp",
    connectionMode: "keyless",
    docsUrl: "https://exa.ai",
    connected: false,
  },
  {
    slug: "linear",
    displayName: "Linear",
    description: "Manage Linear issues and projects — via MCP.",
    url: "https://mcp.linear.app/mcp",
    connectionMode: "oauth",
    docsUrl: "https://linear.app",
    connected: false,
  },
  {
    slug: "notion",
    displayName: "Notion",
    description: "Search and update pages, databases, and workspace content.",
    url: "https://mcp.notion.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    connected: false,
  },
  {
    slug: "sentry",
    displayName: "Sentry",
    description: "Investigate errors, traces, releases, and projects.",
    url: "https://mcp.sentry.dev/mcp",
    connectionMode: "oauth",
    docsUrl: "https://mcp.sentry.dev/",
    connected: false,
  },
  {
    slug: "attio",
    displayName: "Attio",
    description: "Work with CRM records, lists, notes, and tasks.",
    url: "https://mcp.attio.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://docs.attio.com/mcp/overview",
    connected: false,
  },
  {
    slug: "railway",
    displayName: "Railway",
    description: "Inspect and manage projects, services, and deployments.",
    url: "https://mcp.railway.com",
    connectionMode: "oauth",
    docsUrl: "https://docs.railway.com/ai/mcp-server",
    connected: false,
  },
  {
    slug: "posthog",
    displayName: "PostHog",
    description: "Explore product analytics, errors, flags, and experiments.",
    url: "https://mcp.posthog.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    connected: false,
  },
  {
    slug: "sumble",
    displayName: "Sumble",
    description: "Research accounts, people, technologies, and buying signals.",
    url: "https://mcp.sumble.com/",
    connectionMode: "oauth",
    docsUrl: "https://sumble.com/guides/account-research",
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
    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
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
  test("shows verified one-click tool connectors, never providers or API-key catalog entries", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);

    expect(names).toContain("Granola");
    expect(names).toContain("Exa");
    expect(names).toContain("Linear");
    expect(names).not.toContain("GitHub");
    expect(names).not.toContain("ScrapeCreators");
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
      connectButtons.some((button) => button.textContent === "Connect"),
    ).toBe(true);
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

  test("omits every catalog entry that lacks verified one-click authorization", async () => {
    stubFetch();
    const el = mount(baseProps());
    await settle();

    const names = Array.from(
      el.querySelectorAll(".plugins-directory-name"),
    ).map((node) => node.textContent);
    for (const excluded of [
      "GitHub",
      "ScrapeCreators",
      "Slack",
      "Vercel",
      "Render",
      "HubSpot",
      "Zoom",
      "Google Workspace",
      "Browserbase",
    ]) {
      expect(names).not.toContain(excluded);
    }
    expect(el.querySelector(".plugins-directory-add-mcp-action")).toBeNull();
    expect(el.textContent).not.toContain("Add MCP server");
  });
});
