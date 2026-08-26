// MCP preset cards (CL-6152): the connect/disconnect flow hits the exact
// same `/mcp-servers` routes a hand-typed server uses, just with a
// `presetSlug` in the body — this suite fakes `fetch` and asserts the
// right method/URL/body went out, never a real network call.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { MCP_PRESETS } from "@workbench/connections/mcp-presets";

import { McpPresetCardsSection } from "../src/mcp-preset-cards";

const realFetch = globalThis.fetch;
let mountedRoots: Root[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  window.history.replaceState(null, "", "https://workbench.test/");
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots = [];
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function mountSection() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(<McpPresetCardsSection tenantId="tenant_test" />);
  });
  return container;
}

const PRESETS = [
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
    slug: "github-mcp",
    displayName: "GitHub MCP",
    description: "Search code, work with issues and pull requests.",
    url: "https://api.githubcopilot.com/mcp/",
    connectionMode: "token",
    docsUrl: "https://github.com/settings/tokens",
    tokenSteps: [
      "Open github.com/settings/tokens and generate a new token.",
      "Give it the repo scope.",
      "Paste it below.",
    ],
    connected: false,
  },
];

describe("McpPresetCardsSection", () => {
  test("renders one compact row per preset with its outcome sentence", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: PRESETS }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    expect(container.textContent).toContain("Granola");
    expect(container.textContent).toContain("Exa");
    expect(container.textContent).toContain(
      "Search the web (Exa) — no key needed.",
    );
    expect(container.textContent).toContain("Not connected");
    expect(container.querySelectorAll("[data-plugin-slug]")).toHaveLength(3);
    expect(
      container
        .querySelector('[data-plugin-slug="exa"] svg')
        ?.getAttribute("viewBox"),
    ).toBe("0 0 151 182");
  });

  // CL-6794: Connect's accessible name must name the preset so a gallery of
  // identical "Connect" verbs is distinguishable to a screen reader; the
  // visible label stays the single verb.
  test("Connect's accessible name includes the preset display name (CL-6794)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: PRESETS }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const connectExa = container.querySelector('[aria-label="Connect Exa"]');
    expect(connectExa).not.toBeNull();
    expect(connectExa?.textContent?.trim()).toBe("Connect");

    const connectGranola = container.querySelector(
      '[aria-label="Connect Granola"]',
    );
    expect(connectGranola).not.toBeNull();
    expect(connectGranola?.textContent?.trim()).toBe("Connect");
  });

  test("Connect Granola navigates to /start via location href, never fetch", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: PRESETS }));
    }) as unknown as typeof fetch;

    const assigned: string[] = [];
    const hrefDescriptor = Object.getOwnPropertyDescriptor(
      window.location,
      "href",
    );
    Object.defineProperty(window.location, "href", {
      configurable: true,
      get() {
        return (
          hrefDescriptor?.get?.call(window.location) ??
          "https://workbench.test/"
        );
      },
      set(value: string) {
        assigned.push(value);
      },
    });

    try {
      const container = mountSection();
      await settle();

      const granolaCard = container.querySelector(
        '[data-plugin-slug="granola"]',
      ) as HTMLElement;
      const connectButton = [...granolaCard.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Connect"),
      ) as HTMLButtonElement;

      await act(async () => {
        connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(assigned).toEqual([
        "/api/tenants/tenant_test/mcp-servers/oauth/granola/start",
      ]);
      expect(calls.some((url) => url.includes("/start"))).toBe(false);
    } finally {
      if (hrefDescriptor !== undefined) {
        Object.defineProperty(window.location, "href", hrefDescriptor);
      } else {
        delete (window.location as { href?: string }).href;
      }
    }
  });

  test("an OAuth error return surfaces a sentence on that preset row and leaves Connect as retry", async () => {
    window.history.replaceState(
      null,
      "",
      "/?mcpOauth=granola&outcome=error&code=discovery_failed",
    );
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: PRESETS }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const granolaCard = container.querySelector(
      '[data-plugin-slug="granola"]',
    ) as HTMLElement;
    expect(granolaCard.textContent).toContain(
      "Couldn't reach that app's sign-in. Try connecting again.",
    );
    expect(
      granolaCard.querySelector('[aria-label="Connect Granola"]'),
    ).not.toBeNull();

    const exaCard = container.querySelector(
      '[data-plugin-slug="exa"]',
    ) as HTMLElement;
    expect(exaCard.textContent).not.toContain(
      "Couldn't reach that app's sign-in. Try connecting again.",
    );
  });

  test("a client_rejected OAuth return names the registration failure, not unreachable sign-in", async () => {
    window.history.replaceState(
      null,
      "",
      "/?mcpOauth=canva&outcome=error&code=client_rejected",
    );
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            ...PRESETS,
            {
              slug: "canva",
              displayName: "Canva",
              description: "Design with Canva — via MCP.",
              url: "https://mcp.canva.com/mcp",
              connectionMode: "oauth",
              docsUrl: "https://www.canva.com",
              connected: false,
            },
          ],
        }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const canvaCard = container.querySelector(
      '[data-plugin-slug="canva"]',
    ) as HTMLElement;
    expect(canvaCard.textContent).toContain(
      "That app didn't accept Workbench as a client (redirect URL or registration). Try connecting again.",
    );
    expect(canvaCard.textContent).not.toContain(
      "Couldn't reach that app's sign-in. Try connecting again.",
    );
    expect(
      canvaCard.querySelector('[aria-label="Connect Canva"]'),
    ).not.toBeNull();

    const granolaCard = container.querySelector(
      '[data-plugin-slug="granola"]',
    ) as HTMLElement;
    expect(granolaCard.textContent).not.toContain(
      "That app didn't accept Workbench as a client (redirect URL or registration). Try connecting again.",
    );
  });

  test("Disconnect's accessible name includes the preset display name (CL-6794)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: PRESETS.map((p) =>
            p.slug === "exa" ? { ...p, connected: true } : p,
          ),
        }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const disconnectExa = container.querySelector(
      '[aria-label="Disconnect Exa"]',
    );
    expect(disconnectExa).not.toBeNull();
    expect(disconnectExa?.textContent?.trim()).toBe("Disconnect");
  });

  test("connect calls the preset connect route with the preset's slug", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let connected = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (init?.method === "POST") {
        connected = true;
        return new Response(
          JSON.stringify({
            slug: "exa",
            name: "Exa",
            url: "https://mcp.exa.ai/mcp",
            toolCount: 4,
          }),
        );
      }
      return new Response(
        JSON.stringify({
          data: PRESETS.map((p) =>
            p.slug === "exa" ? { ...p, connected } : p,
          ),
        }),
      );
    }) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const exaCard = container.querySelector(
      '[data-plugin-slug="exa"]',
    ) as HTMLElement;
    const connectButton = [...exaCard.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Connect"),
    ) as HTMLButtonElement;

    await act(async () => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const connectCall = calls.find((call) => call.init?.method === "POST");
    expect(connectCall).not.toBeUndefined();
    expect(connectCall?.url).toBe("/api/tenants/tenant_test/mcp-servers");
    const body: unknown = JSON.parse(connectCall?.init?.body as string);
    expect(body).toMatchObject({ presetSlug: "exa" });

    expect(container.textContent).toContain("4 tools");
  });

  test("a token preset opens step-by-step guidance and posts the pasted token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let connected = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (init?.method === "POST") {
        connected = true;
        return new Response(
          JSON.stringify({
            slug: "github-mcp",
            name: "GitHub MCP",
            url: "https://api.githubcopilot.com/mcp/",
            toolCount: 40,
          }),
        );
      }
      return new Response(
        JSON.stringify({
          data: PRESETS.map((p) =>
            p.slug === "github-mcp" ? { ...p, connected } : p,
          ),
        }),
      );
    }) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const card = container.querySelector(
      '[data-plugin-slug="github-mcp"]',
    ) as HTMLElement;
    const connectButton = [...card.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Connect"),
    ) as HTMLButtonElement;

    await act(async () => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Opening the form is not a connect — no POST yet, steps visible.
    expect(calls.find((call) => call.init?.method === "POST")).toBeUndefined();
    expect(card.textContent).toContain(
      "Open github.com/settings/tokens and generate a new token.",
    );
    expect(card.textContent).toContain("Give it the repo scope.");
    expect(
      card.querySelector('a[href="https://github.com/settings/tokens"]'),
    ).not.toBeNull();

    const field = card.querySelector(
      "#mcp-preset-token-github-mcp",
    ) as HTMLInputElement;
    expect(field).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "ghp_pasted");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitButton = [...card.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submitButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const connectCall = calls.find((call) => call.init?.method === "POST");
    expect(connectCall?.url).toBe("/api/tenants/tenant_test/mcp-servers");
    const body: unknown = JSON.parse(connectCall?.init?.body as string);
    expect(body).toMatchObject({
      presetSlug: "github-mcp",
      token: "ghp_pasted",
    });
    expect(container.textContent).toContain("40 tools");
  });

  test("disconnect calls DELETE on the preset's slug", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let deleted = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          data: PRESETS.map((p) =>
            p.slug === "exa" ? { ...p, connected: !deleted } : p,
          ),
        }),
      );
    }) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const exaCard = container.querySelector(
      '[data-plugin-slug="exa"]',
    ) as HTMLElement;
    const disconnectButton = [...exaCard.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect"),
    ) as HTMLButtonElement;

    await act(async () => {
      disconnectButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const confirmButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Disconnect",
    ) as HTMLButtonElement;
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const deleteCall = calls.find((call) => call.init?.method === "DELETE");
    expect(deleteCall).not.toBeUndefined();
    expect(deleteCall?.url).toBe("/api/tenants/tenant_test/mcp-servers/exa");
  });

  // CL-6472: a fresh bench with zero connections still owns the same
  // curated catalog — the route returns all 10 presets regardless, so
  // every one of them must reach the page.
  test("every preset the route returns reaches the page on a fresh bench", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: MCP_PRESETS.map((preset) => ({
            slug: preset.slug,
            displayName: preset.displayName,
            description: preset.description,
            url: preset.url,
            connectionMode: preset.connectionMode,
            docsUrl: preset.docsUrl,
            ...(preset.icon === undefined ? {} : { icon: preset.icon }),
            ...(preset.tokenSteps === undefined
              ? {}
              : { tokenSteps: preset.tokenSteps }),
            connected: false,
          })),
        }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    expect(container.querySelectorAll("[data-plugin-slug]")).toHaveLength(
      MCP_PRESETS.length,
    );
    for (const preset of MCP_PRESETS) {
      expect(container.textContent).toContain(preset.displayName);
    }
  });

  // CL-6472: this section must never silently disappear. Before this
  // fix it `return null`ed for any load that resolved with zero presets
  // (including one still in flight), which is indistinguishable from the
  // whole "Connect apps" catalog vanishing.
  test("never renders nothing — a failed load surfaces an error, not silence", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
      })) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    expect(container.textContent).toContain("Connect apps");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
