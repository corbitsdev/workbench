// The gallery renders from a fixture registry: cards for every resolved
// plugin, the installed strip only for connected/needs-attention ones,
// search filtering both tabs, outcome copy on every card, and the Skills
// tab mounting its own card grid rather than the Settings list rows.

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectorDescriptor } from "@workbench/connections/registry";
import type { ResolvedPlugin } from "@workbench/connections/plugins";

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
    // A non-empty `feedsTools` marks a real tool connector rather than an
    // inference provider (CL-6272.2) — every fixture here is a tool
    // connector, never a provider, so this suite exercises the plugin
    // grid rather than the provider-exclusion rule.
    feedsTools: [`@corbits/${id}-tools`],
  };
}

const CONNECTED: ResolvedPlugin = {
  descriptor: descriptor("github", "GitHub"),
  status: "connected",
  provenance: "this-workbench",
  credentialId: "cred_github",
  credentialName: "GitHub",
};

// Not "scrapecreators" — that id is now an MCP-preset connector
// (CL-6256) filtered out of this static grid, which would make this
// fixture's row vanish for a reason unrelated to what this suite tests.
const INHERITED: ResolvedPlugin = {
  descriptor: descriptor("notion", "Notion"),
  status: "connected",
  provenance: "inherited",
  credentialId: "cred_notion",
  credentialName: "Notion",
};

const NOT_CONNECTED: ResolvedPlugin = {
  descriptor: descriptor("huggingface", "Hugging Face"),
  status: "not_connected",
  provenance: null,
  credentialId: null,
  credentialName: null,
};

const PLUGINS: readonly ResolvedPlugin[] = [
  CONNECTED,
  INHERITED,
  NOT_CONNECTED,
];

const PROVIDER: ResolvedPlugin = {
  descriptor: {
    id: "anthropic",
    displayName: "Anthropic",
    authKind: "api-key",
    docsUrl: "https://example.test/anthropic",
    credentialPlugin: "http",
    // Real inference-provider descriptors feed no tool package.
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

// `McpServersSection` fetches its server list on mount — stub `fetch` so
// this suite (which only exercises the plugin/skill grid) never issues a
// real request, and resolve within an `act()` flush so the state update
// isn't reported unwrapped.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/webhook-triggers") || url.includes("/routines")) {
    return new Response(JSON.stringify({ items: [] }));
  }
  return new Response(JSON.stringify({ data: [], nextCursor: null }));
}) as unknown as typeof fetch;

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

function renderGallery(
  plugins: readonly ResolvedPlugin[] = PLUGINS,
  initialQuery = "",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <GalleryHarness plugins={plugins} initialQuery={initialQuery} />,
    );
  });
  return { container, root };
}

describe("PluginsGallery", () => {
  test("renders every tool connector regardless of connection state (CL-6386)", () => {
    const { container } = renderGallery();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Hugging Face");
    expect(container.textContent).toContain(
      "Lets agents read and open pull requests in your GitHub repos.",
    );
  });

  test("a not-connected tool connector renders a Connect affordance", () => {
    const { container } = renderGallery();

    const connectButton = container.querySelector(
      '[aria-label="Connect Hugging Face"]',
    );
    expect(connectButton).not.toBeNull();
  });

  test("filters out the old registry card for a connector an MCP preset now fronts", () => {
    const { container } = renderGallery();

    expect(container.textContent).not.toContain(
      "Lets agents run live web search and research lookups.",
    );
  });

  test("does not duplicate connected plugins in an icon-only strip", () => {
    const { container } = renderGallery();

    const strip = container.querySelector('[aria-label="Installed plugins"]');
    expect(strip).toBeNull();
  });

  test("provenance reads as plain words on a plugin card", () => {
    const { container } = renderGallery();

    expect(container.textContent).toContain("Connected here");
    expect(container.textContent).toContain("Inherited");
  });

  test("the plugins tab renders the list heading and directory sub copy (CL-6467)", () => {
    const { container } = renderGallery();

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Plugins");
    expect(container.textContent).toContain(
      "A directory to scan, not tiles to admire — one dense row per connector, grouped by what it does. Click a row's name for the full page.",
    );
  });

  test("a plugin row's status caption is never hidden — it is a core column, not overflow (CL-6467)", () => {
    const { container } = renderGallery();

    expect(container.textContent).toContain("Connected here");
    const captions = [...container.querySelectorAll("span")].filter(
      (span) => span.textContent === "Connected · Connected here",
    );
    expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) {
      expect(caption.className).not.toContain("hidden");
    }
  });

  test("an empty plugin directory renders no group rows", () => {
    const { container } = renderGallery([]);

    expect(container.querySelector(".border.border-border")).toBeNull();
  });

  test("search narrows the plugin grid to matches only", () => {
    const { container } = renderGallery(PLUGINS, "git");

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).not.toContain("Hugging Face");
  });

  test("switching to the Skills tab renders skill cards with outcome copy and scope badges", () => {
    const { container } = renderGallery();
    const skillsTab = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    expect(skillsTab).not.toBeUndefined();

    act(() => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Weekly digest");
    expect(container.textContent).toContain(
      "Summarizes the week's channel activity.",
    );
    expect(container.textContent).toContain("Shared with everyone");
    expect(container.textContent).toContain("Just you");
  });

  test("an inference provider never appears in the plugin directory (CL-6272.2)", () => {
    const { container } = renderGallery([...PLUGINS, PROVIDER]);

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).not.toContain("Anthropic");
  });

  test("omits unverified MCP suggestions and API-key-only registry entries", () => {
    const { container } = renderGallery();

    for (const excluded of [
      "Slack",
      "Vercel",
      "Render",
      "HubSpot",
      "Zoom",
      "Google Workspace",
      "Browserbase",
      "ScrapeCreators",
    ]) {
      expect(container.textContent).not.toContain(excluded);
    }
    expect(container.textContent).not.toContain("Add MCP server");
  });
});
