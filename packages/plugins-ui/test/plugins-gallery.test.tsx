import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectorDescriptor } from "@corbits/connections/registry";
import type { ResolvedPlugin } from "@corbits/connections/plugins";
import { MCP_PRESETS } from "@workbench/templates/connectors";

import { PluginsGallery } from "../src/plugins-gallery";
import type { SkillCardData } from "../src/skill-card";

function descriptor(
  id: string,
  displayName: string,
  authKind: ConnectorDescriptor["authKind"] = "api-key",
): ConnectorDescriptor {
  return {
    id,
    displayName,
    authKind,
    docsUrl: `https://example.test/${id}`,
    credentialPlugin: "http",
    feedsTools: [`@corbits/${id}-tools`],
  };
}

function plugin(
  id: string,
  displayName: string,
  status: ResolvedPlugin["status"],
): ResolvedPlugin {
  const pluginDescriptor = descriptor(id, displayName);
  if (status === "not_connected") {
    return {
      descriptor: pluginDescriptor,
      status,
      provenance: null,
      credentialId: null,
      credentialName: null,
    };
  }
  return {
    descriptor: pluginDescriptor,
    status,
    provenance: "this-workbench",
    credentialId: `cred_${id}`,
    credentialName: displayName,
  };
}

const PLUGINS: readonly ResolvedPlugin[] = [
  plugin("github", "GitHub", "connected"),
  plugin("notion", "Notion registry duplicate", "connected"),
  plugin("huggingface", "Hugging Face", "not_connected"),
  plugin("manus", "Manus", "not_connected"),
  plugin("scrapecreators", "ScrapeCreators", "connected"),
];

const PROVIDER: ResolvedPlugin = {
  descriptor: {
    id: "anthropic",
    displayName: "Anthropic",
    authKind: "api-key",
    docsUrl: "https://example.test/anthropic",
    credentialPlugin: "http",
    feedsTools: [],
  },
  status: "connected",
  provenance: "this-workbench",
  credentialId: "cred_anthropic",
  credentialName: "Anthropic",
};

const SKILLS: readonly SkillCardData[] = [
  {
    assetId: "skill_1",
    name: "Weekly digest",
    description: "Summarizes the week's channel activity.",
    scope: "tenant",
  },
  {
    assetId: "skill_2",
    name: "Draft replies",
    description: "Drafts a reply in my voice.",
    scope: "private",
  },
];

const PRESETS = MCP_PRESETS.map((preset) => ({
  slug: preset.slug,
  displayName: preset.displayName,
  description: preset.description,
  url: preset.url,
  connectionMode: preset.connectionMode,
  docsUrl: preset.docsUrl,
  ...(preset.icon === undefined ? {} : { icon: preset.icon }),
  ...(preset.tokenSteps === undefined ? {} : { tokenSteps: preset.tokenSteps }),
  connected: preset.slug === "exa",
}));

const realFetch = globalThis.fetch;
let mountedRoots: Root[] = [];

function installFetch(presets: readonly (typeof PRESETS)[number][] = PRESETS) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/mcp-servers/presets")) {
      return new Response(JSON.stringify({ data: presets }));
    }
    if (url.includes("/webhook-triggers") || url.includes("/routines")) {
      return new Response(JSON.stringify({ items: [] }));
    }
    return new Response(JSON.stringify({ data: [], nextCursor: null }));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots = [];
  document.body.replaceChildren();
});

function GalleryHarness({
  plugins,
  initialQuery,
}: {
  readonly plugins: readonly ResolvedPlugin[];
  readonly initialQuery: string;
}) {
  const [activeTab, setActiveTab] = useState<"plugins" | "skills">("plugins");
  return (
    <PluginsGallery
      tenantId="tenant_test"
      plugins={plugins}
      skills={SKILLS}
      onOpenPlugin={() => {}}
      onOpenSkill={() => {}}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      query={initialQuery}
    />
  );
}

async function renderGallery(
  plugins: readonly ResolvedPlugin[] = PLUGINS,
  initialQuery = "",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <GalleryHarness plugins={plugins} initialQuery={initialQuery} />,
    );
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

function chip(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.startsWith(label) === true,
  );
  if (match === undefined) throw new Error(`Missing ${label} filter chip`);
  return match;
}

function catalogNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-plugin-name]")].map(
    (element) => element.dataset.pluginName ?? "",
  );
}

describe("PluginsGallery", () => {
  test("Plugins and Skills are the only tabs; catalog filters are pressed buttons", async () => {
    const { container } = await renderGallery();

    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(
      container.querySelectorAll(
        '[aria-label="Plugin catalog filters"] [role="tab"]',
      ),
    ).toHaveLength(0);
    expect(container.querySelector('[aria-label="Filter plugins"]')).toBeNull();
    expect(chip(container, "All").getAttribute("aria-pressed")).toBe("true");
    expect(
      chip(container, "Research & data").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("chip counts describe the query-matched catalog", async () => {
    const { container } = await renderGallery();

    expect(chip(container, "All").textContent).toContain("15");
    expect(chip(container, "Connected").textContent).toContain("3");
    expect(chip(container, "Communication").textContent).toContain("0");
    expect(chip(container, "Productivity").textContent).toContain("4");
    expect(chip(container, "Sales & customer").textContent).toContain("1");
    expect(chip(container, "Engineering").textContent).toContain("6");
    expect(chip(container, "Research & data").textContent).toContain("3");
  });

  test("category filtering keeps one unified catalog", async () => {
    const { container } = await renderGallery();

    act(() => {
      chip(container, "Research & data").click();
    });

    expect(catalogNames(container)).toEqual([
      "Exa",
      "Sumble",
      "ScrapeCreators",
    ]);
    expect(
      container.querySelectorAll('[aria-label="Plugin catalog"]'),
    ).toHaveLength(1);
  });

  test("search and a chip filter intersect instead of replacing each other", async () => {
    const { container } = await renderGallery(PLUGINS, "live web");

    expect(chip(container, "All").textContent).toContain("1");
    expect(chip(container, "Research & data").textContent).toContain("1");
    act(() => {
      chip(container, "Research & data").click();
    });
    expect(catalogNames(container)).toEqual(["Exa"]);
  });

  test("original categories separate productivity and sales and handle empty groups", async () => {
    const { container } = await renderGallery();

    act(() => chip(container, "Productivity").click());
    expect(catalogNames(container)).toEqual([
      "Granola",
      "Notion",
      "Canva",
      "Manus",
    ]);

    act(() => chip(container, "Sales & customer").click());
    expect(catalogNames(container)).toEqual(["Attio"]);

    act(() => chip(container, "Communication").click());
    expect(catalogNames(container)).toEqual([]);
    expect(container.textContent).toContain(
      "No plugins are available in this filter.",
    );
  });

  test("search matches the original category labels", async () => {
    const { container } = await renderGallery(PLUGINS, "engineering");

    expect(catalogNames(container)).toEqual([
      "Linear",
      "GitHub MCP",
      "Sentry",
      "Railway",
      "PostHog",
      "GitHub",
    ]);
    expect(chip(container, "Engineering").textContent).toContain("6");
  });

  test("preset-backed registry entries and inference providers stay out of the catalog", async () => {
    const { container } = await renderGallery([...PLUGINS, PROVIDER]);

    expect(container.textContent).toContain("Notion");
    expect(container.textContent).not.toContain("Notion registry duplicate");
    expect(container.textContent).not.toContain("Anthropic");
  });

  test("connected and disconnected entries preserve Manage and Connect flows", async () => {
    const { container } = await renderGallery();

    expect(
      container.querySelector('[aria-label="Manage GitHub"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Connect Manus"]'),
    ).not.toBeNull();
    const exa = container.querySelector('[data-plugin-slug="exa"]');
    expect(exa?.textContent).toContain("Connected");
    expect(exa?.textContent).toContain("Manage");
  });

  test("status remains visible as a core field", async () => {
    const { container } = await renderGallery();
    const caption = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "Connected · Connected here",
    );

    expect(caption).not.toBeUndefined();
    expect(caption?.className).not.toContain("hidden");
  });

  test("switching to Skills preserves the existing skill gallery", async () => {
    const { container } = await renderGallery();
    const skillsTab = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );

    act(() => {
      skillsTab?.click();
    });

    expect(container.textContent).toContain("Weekly digest");
    expect(container.textContent).toContain("Shared with everyone");
    expect(container.textContent).toContain("Just you");
  });

  test("every preset returned by the route reaches a fresh catalog", async () => {
    const { container } = await renderGallery([]);

    expect(container.querySelectorAll("[data-plugin-slug]")).toHaveLength(
      MCP_PRESETS.length,
    );
    for (const preset of MCP_PRESETS) {
      expect(container.textContent).toContain(preset.displayName);
    }
  });

  test("a failed preset load reports the error and still shows native plugins", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/mcp-servers/presets")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ data: [], nextCursor: null }));
    }) as unknown as typeof fetch;

    const { container } = await renderGallery();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("GitHub");
  });
});
