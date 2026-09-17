import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { InviteAgentDialog } from "../src/invite-agent-dialog";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: {
  invitable: () => readonly {
    id: string;
    name: string;
    description?: string;
  }[];
}) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path.endsWith("/invitable")) {
      return Promise.resolve(jsonResponse({ items: routes.invitable() }));
    }
    throw new Error(`unstubbed fetch: ${String(init?.method)} ${path}`);
  }) as typeof fetch;
}

async function mount(props: {
  readonly invitable: () => readonly {
    id: string;
    name: string;
    description?: string;
  }[];
  readonly onInvite: (definitionId: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  stubFetch({ invitable: props.invitable });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <InviteAgentDialog
        open={true}
        onOpenChange={props.onOpenChange}
        tenantId="tnt_1"
        workbenchId="wb_1"
        onInvite={props.onInvite}
      />,
    );
  });
  // Flush the effect's `listInvitableDefinitions` promise.
  await act(async () => {
    await Promise.resolve();
  });
  // `Dialog` portals its content to `document.body`, not into `container`.
  return document.body;
}

describe("InviteAgentDialog definition rows (CL-6424)", () => {
  test("shows each definition's display name, never its raw slug", async () => {
    const el = await mount({
      invitable: () => [
        { id: "wfd_myra", name: "myra", description: "Myra" },
        { id: "wfd_review", name: "code-review" },
      ],
      onInvite: async () => undefined,
      onOpenChange: () => undefined,
    });
    const names = Array.from(
      el.querySelectorAll('[data-testid="invitable-definition"] .chat-invitable-item-name'),
    ).map((name) => name.textContent);
    expect(names).toEqual(["Myra", "Code Review"]);
  });
});
