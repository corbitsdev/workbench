// Custom MCP rows (CL-6794): already-connected hand-typed servers keep a
// Disconnect affordance whose accessible name must name the server — the
// same "verb + display name" pattern Connect/Manage use on registry and
// preset rows. Visible label stays the single verb.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { McpServersSection } from "../src/mcp-servers-section";

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
    root.render(<McpServersSection tenantId="tenant_test" />);
  });
  return container;
}

describe("McpServersSection", () => {
  test("Disconnect's accessible name includes the custom server name (CL-6794)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              slug: "my-custom",
              name: "My Custom MCP",
              url: "https://mcp.example.test/mcp",
            },
          ],
        }),
      )) as unknown as typeof fetch;

    const container = mountSection();
    await settle();

    const disconnect = container.querySelector(
      '[aria-label="Disconnect My Custom MCP"]',
    );
    expect(disconnect).not.toBeNull();
    expect(disconnect?.textContent?.trim()).toBe("Disconnect");
  });
});
