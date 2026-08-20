// The connect panel opens the right surface per connector kind: an OAuth
// link for `oauth-pkce`/`oauth-code`, a single-action connect form for
// `api-key` (CL-6377: no separate test step), and — for Granola
// specifically — both the api-key form and `GranolaWebhookCard` stacked
// in the same panel, never a second dialog.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectorDescriptor } from "@workbench/connections/registry";
import type { ResolvedPlugin } from "@workbench/connections/plugins";

import { PluginConnectPanel } from "../src/plugin-connect-panel";

const realFetch = globalThis.fetch;
let mountedRoots: Root[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots = [];
});

function descriptor(
  id: string,
  displayName: string,
  authKind: ConnectorDescriptor["authKind"],
): ConnectorDescriptor {
  return {
    id,
    displayName,
    authKind,
    docsUrl: `https://example.test/${id}`,
    credentialPlugin: "http",
    feedsTools: [],
  };
}

function notConnected(d: ConnectorDescriptor): ResolvedPlugin {
  return {
    descriptor: d,
    status: "not_connected",
    provenance: null,
    credentialId: null,
    credentialName: null,
  };
}

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

// Dialog content renders through a Radix portal appended to
// `document.body`, not inside the mount container — every assertion below
// reads from `document.body` for that reason.
function render(plugin: ResolvedPlugin | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <PluginConnectPanel
        tenantId="ten_1"
        plugin={plugin}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
  });
  return document.body;
}

describe("PluginConnectPanel", () => {
  test("an oauth-pkce connector shows an OAuth connect link, not a key form", () => {
    const container = render(
      notConnected(descriptor("huggingface", "Hugging Face", "oauth-pkce")),
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/api/onboarding/oauth/huggingface/start?return=%2Fplugins",
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  // CL-6377: one Connect action — no separate test step or "Test" copy.
  test("an api-key connector shows the connect form", () => {
    const container = render(notConnected(descriptor("exa", "Exa", "api-key")));

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).toContain("Connect");
    expect(container.textContent).not.toContain("Test");
    expect(container.querySelector("a")).toBeNull();
  });

  test("Granola stacks the api-key form and the webhook card in one panel", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/routines")) {
        return new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/workflow-definitions")) {
        return new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/webhook-triggers")) {
        return new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = render(
      notConnected(descriptor("granola", "Granola", "api-key")),
    );
    await settle();

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).toContain("Inbound webhook");
  });

  test("a failed disconnect shows an inline error, not a silent no-op", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
      )) as unknown as typeof fetch;

    const container = render({
      descriptor: descriptor("github", "GitHub", "api-key"),
      status: "connected",
      provenance: "this-workbench",
      credentialId: "cred_github",
      credentialName: "GitHub",
    });

    const disconnectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect") === true,
    );
    expect(disconnectButton).not.toBeUndefined();

    act(() => {
      disconnectButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => {
      disconnectButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();

    expect(container.textContent).toContain("Couldn't disconnect");
  });

  test("nothing renders when no plugin is selected", () => {
    const container = render(null);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});
