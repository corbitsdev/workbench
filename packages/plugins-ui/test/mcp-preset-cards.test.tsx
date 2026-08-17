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
];

describe("McpPresetCardsSection", () => {
  test("renders one card per preset with its outcome sentence and the MCP hint", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: PRESETS }))) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    expect(container.textContent).toContain("Granola");
    expect(container.textContent).toContain("Exa");
    expect(container.textContent).toContain(
      "Search the web (Exa) — no key needed.",
    );
    expect(container.textContent).toContain("via MCP");
    expect(container.textContent).toContain("Not connected");
  });

  test("connect calls the preset connect route with the preset's slug", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let connected = false;
    globalThis.fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
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

    const exaCard = [...container.querySelectorAll(".p-4")].find((el) =>
      el.textContent?.includes("Exa"),
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

  test("disconnect calls DELETE on the preset's slug", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let deleted = false;
    globalThis.fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
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

    const exaCard = [...container.querySelectorAll(".p-4")].find((el) =>
      el.textContent?.includes("Exa"),
    ) as HTMLElement;
    const disconnectButton = [...exaCard.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect"),
    ) as HTMLButtonElement;

    await act(async () => {
      disconnectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    expect(deleteCall?.url).toBe(
      "/api/tenants/tenant_test/mcp-servers/exa",
    );
  });
});
