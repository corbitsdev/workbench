// MCP preset cards (CL-6152): the connect/disconnect flow hits the exact
// same `/mcp-servers` routes a hand-typed server uses, just with a
// `presetSlug` in the body — this suite fakes `fetch` and asserts the
// right method/URL/body went out, never a real network call.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { McpPresetCardsSection } from "../src/mcp-preset-cards";

const realFetch = globalThis.fetch;
let mountedRoots: Root[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
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
    const connectButton = [...card.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Connect"),
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
});
