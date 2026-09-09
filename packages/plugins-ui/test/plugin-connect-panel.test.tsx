// The connect panel opens the right surface per connector kind: an OAuth
// link for `oauth-pkce`/`oauth-code`, a single-action connect form for
// `api-key` (CL-6377: no separate test step), and — for Granola
// specifically — both the api-key form and `GranolaWebhookCard` stacked
// in the same panel, never a second dialog.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectorDescriptor } from "@corbits/connections/registry";
import type { ResolvedPlugin } from "@corbits/connections/plugins";

import {
  PluginConnectPanel,
  type PluginPanelSubject,
} from "../src/plugin-connect-panel";
import type { McpPreset } from "../src/mcp-servers-api";
import { PLUGINS_STRINGS } from "../src/strings";

const realFetch = globalThis.fetch;
let mountedRoots: Root[] = [];
// The panel fetches `/connections/oauth-configured` on open (CL-6386) —
// every test that doesn't care about that response gets this quiet
// default rather than a real network attempt; a test exercising a
// different fetch behavior overrides `globalThis.fetch` itself before
// rendering.
beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});
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
function connectorSubject(plugin: ResolvedPlugin): PluginPanelSubject {
  return { kind: "connector", plugin };
}

function render(
  subject: PluginPanelSubject | null,
  onChanged: (toolCount?: number) => void = () => {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <PluginConnectPanel
        tenantId="ten_1"
        subject={subject}
        onClose={() => {}}
        onChanged={onChanged}
      />,
    );
  });
  return document.body;
}

describe("PluginConnectPanel", () => {
  test("an oauth-pkce connector shows an OAuth connect link, not a key form", () => {
    const container = render(
      connectorSubject(
        notConnected(descriptor("huggingface", "Hugging Face", "oauth-pkce")),
      ),
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/api/tenants/ten_1/connections/oauth/huggingface/start?return=%2Fplugins",
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  // CL-6377: one Connect action — no separate test step or "Test" copy.
  test("an api-key connector shows the connect form", () => {
    const container = render(
      connectorSubject(notConnected(descriptor("exa", "Exa", "api-key"))),
    );

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
      connectorSubject(
        notConnected(descriptor("granola", "Granola", "api-key")),
      ),
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

    const container = render(
      connectorSubject({
        descriptor: descriptor("github", "GitHub", "api-key"),
        status: "connected",
        provenance: "this-workbench",
        credentialId: "cred_github",
        credentialName: "GitHub",
      }),
    );

    const disconnectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect") === true,
    );
    expect(disconnectButton).not.toBeUndefined();
    expect(disconnectButton?.className).toContain("border-input");
    expect(disconnectButton?.className).not.toContain("bg-destructive");
    expect(container.textContent).not.toContain("Close");

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

    expect(container.textContent).toContain(PLUGINS_STRINGS.disconnectError);
  });

  function githubDescriptor(): ConnectorDescriptor {
    return {
      ...descriptor("github", "GitHub", "api-key"),
      docsUrl: "https://github.com/settings/tokens",
      oauth: {
        authorizeUrl: "https://github.com/login/oauth/authorize",
        usesPKCE: false,
        echoesState: true,
        deploysDefaultWorkflows: false,
        buildAuthorizeUrl: ({ callbackUrl }) => new URL(callbackUrl),
        exchange: async () => ({ ok: false, message: "unused in this test" }),
      },
    };
  }

  test("GitHub with the hosted app configured shows one Connect button, no token field", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ github: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const container = render(
      connectorSubject(notConnected(githubDescriptor())),
    );
    await settle();

    const link = container.querySelector("a");
    expect(link?.textContent).toContain("Connect with GitHub");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test("GitHub without the hosted app configured falls back to a token paste with honest copy", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ github: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const container = render(
      connectorSubject(notConnected(githubDescriptor())),
    );
    await settle();

    expect(container.textContent).toContain(
      "This workbench isn't set up with the one-click GitHub app",
    );
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  // CL-6830: a failed oauth-configured probe must not collapse into `{}`
  // (which reads as "hosted app absent" and hides one-click connect).
  test("GitHub when the oauth-configured probe fails shows error and retry, not the not-configured token paste", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    const container = render(
      connectorSubject(notConnected(githubDescriptor())),
    );
    await settle();

    expect(container.textContent).toContain("Couldn't check");
    expect(container.textContent).toContain("Try again");
    expect(container.textContent).not.toContain(
      "This workbench isn't set up with the one-click GitHub app",
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test("retrying after an oauth-configured probe failure can reveal hosted connect", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("network down"));
      }
      return new Response(JSON.stringify({ github: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const container = render(
      connectorSubject(notConnected(githubDescriptor())),
    );
    await settle();

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Try again") === true,
    );
    expect(retry).not.toBeUndefined();

    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const link = container.querySelector("a");
    expect(link?.textContent).toContain("Connect with GitHub");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test("nothing renders when no plugin is selected", () => {
    const container = render(null);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  test("a token preset renders its guidance and submits the pasted token", async () => {
    const preset: McpPreset = {
      slug: "github-mcp",
      displayName: "GitHub MCP",
      description: "Search code, work with issues and pull requests.",
      url: "https://api.githubcopilot.com/mcp/",
      connectionMode: "token",
      docsUrl: "https://github.com/settings/tokens",
      tokenSteps: ["Create a token with repo scope."],
      connected: false,
    };
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return new Response(
        JSON.stringify({
          slug: preset.slug,
          name: preset.displayName,
          url: preset.url,
          toolCount: 40,
        }),
      );
    }) as unknown as typeof fetch;

    const changed: number[] = [];
    const container = render(
      { kind: "mcp-preset", preset, toolCount: undefined },
      (toolCount) => {
        if (toolCount !== undefined) changed.push(toolCount);
      },
    );
    const field = container.querySelector(
      "#mcp-preset-token-github-mcp",
    ) as HTMLInputElement;
    expect(
      container.querySelector(`label[for="${field.id}"]`)?.textContent,
    ).toContain("Personal access token");
    expect(field.autocomplete).toBe("new-password");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(field, "ghp_pasted");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    );
    await act(async () => {
      connect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/tenants/ten_1/mcp-servers");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      presetSlug: "github-mcp",
      token: "ghp_pasted",
    });
    expect(changed).toEqual([40]);
  });

  test("a connected preset disconnects from the drawer", async () => {
    const preset: McpPreset = {
      slug: "exa",
      displayName: "Exa",
      description: "Search and research the live web.",
      url: "https://mcp.exa.ai/mcp",
      connectionMode: "keyless",
      docsUrl: "https://exa.ai",
      connected: true,
    };
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const container = render({
      kind: "mcp-preset",
      preset,
      toolCount: 2,
    });
    const disconnect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect") === true,
    );
    expect(disconnect?.className).toContain("border-input");
    expect(disconnect?.className).not.toContain("bg-destructive");
    expect(container.textContent).not.toContain("Close");
    act(() => {
      disconnect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Disconnect") === true,
    );
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/tenants/ten_1/mcp-servers/exa");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});
