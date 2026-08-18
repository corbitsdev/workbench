// The gallery renders from a fixture registry: cards for every resolved
// plugin, the installed strip only for connected/needs-attention ones,
// search filtering both tabs, outcome copy on every card, and the Skills
// tab mounting its own card grid rather than the Settings list rows.

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectorDescriptor } from "@workbench/connections/registry";
import type { ResolvedPlugin } from "@workbench/connections/plugins";

import { PluginsGallery } from "../src/plugins-gallery";
import type { SkillCardData } from "../src/skill-card";

const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;
if (nativeSetter === undefined) {
  throw new Error("HTMLInputElement.prototype.value has no native setter");
}

function typeInto(input: HTMLInputElement, value: string) {
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;

function renderGallery(plugins: readonly ResolvedPlugin[] = PLUGINS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <PluginsGallery
        tenantId="tenant_test"
        plugins={plugins}
        skills={SKILLS}
        onOpenPlugin={() => {}}
        onOpenSkill={() => {}}
      />,
    );
  });
  return { container, root };
}

describe("PluginsGallery", () => {
  test("renders a card per resolved plugin with its outcome sentence", () => {
    const { container } = renderGallery();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Hugging Face");
    expect(container.textContent).toContain(
      "Lets agents read and open pull requests in your GitHub repos.",
    );
  });

  test("filters out the old registry card for a connector an MCP preset now fronts", () => {
    const { container } = renderGallery();

    expect(container.textContent).not.toContain(
      "Lets agents run live web search and research lookups.",
    );
  });

  test("the installed strip only carries connected/needs-attention plugins", () => {
    const { container } = renderGallery();

    const strip = container.querySelector('[aria-label="Installed plugins"]');
    expect(strip).not.toBeNull();
    const chips = strip?.querySelectorAll("button") ?? [];
    expect(chips.length).toBe(2);
  });

  test("provenance reads as plain words on a plugin card", () => {
    const { container } = renderGallery();

    expect(container.textContent).toContain("Connected here");
    expect(container.textContent).toContain("Inherited");
  });

  test("search narrows the plugin grid to matches only", () => {
    const { container } = renderGallery();
    const input = container.querySelector(
      'input[aria-label="Search plugins"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      typeInto(input, "git");
    });

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
});
