// DOM coverage for the guided first-workbench screen (CL-6104, step three
// of onboarding's four; CL-6124 replaced its custom form with a chat: one
// prompt box, sending drives the same drafting machinery `CreateAgentPanel`
// uses (`draftAgentDefinition` → `createAgentDefinition` → `launchAgentChat`).
// A failure at any step in that chain shows the real reason inline with the
// message preserved for a straight retry, never a dead spinner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DescribeFirstWorkbench } from "../src/pages/describe-first-workbench";

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CREATED_DEFINITION = {
  id: "wfd_new",
  tenantId: "tnt_1",
  name: "A weekly competitor",
  description: null,
  currentVersion: "1",
  status: "deployed",
  createdAt: "2026-08-05T11:00:00.000Z",
  updatedAt: "2026-08-05T11:00:00.000Z",
  skills: [],
};

function stubFetch(overrides: {
  draft?: (body: Record<string, unknown>) => Response;
  create?: (body: Record<string, unknown>) => Response;
  createChannel?: (body: Record<string, unknown>) => Response;
}): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      init?.body !== undefined
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
    if (url.includes("/planner/agent-definitions/draft")) {
      return Promise.resolve(
        overrides.draft?.(body) ??
          json({ draft: { systemPrompt: "You track competitor moves." } }, 201),
      );
    }
    if (url.endsWith("/agent-definitions")) {
      return Promise.resolve(
        overrides.create?.(body) ?? json(CREATED_DEFINITION, 201),
      );
    }
    if (url.endsWith("/chat/channels")) {
      return Promise.resolve(
        overrides.createChannel?.(body) ??
          json(
            {
              id: "chan_new",
              title: "A weekly competitor",
              kind: "chat",
              pinned: false,
              participants: [],
            },
            201,
          ),
      );
    }
    return Promise.resolve(json({}, 200));
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  stubFetch({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(navigate: (to: string) => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DescribeFirstWorkbench tenantId="tnt_1" navigate={navigate} />,
    );
  });
  return container;
}

function composerInput(c: HTMLDivElement): HTMLTextAreaElement {
  const el = c.querySelector(".first-run-composer-input");
  expect(el).not.toBeNull();
  return el as HTMLTextAreaElement;
}

function nativeValueSetter(): (
  this: HTMLTextAreaElement,
  value: string,
) => void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) {
    throw new Error("native value setter unavailable in this DOM");
  }
  return setter;
}

function typeMessage(c: HTMLDivElement, value: string) {
  const el = composerInput(c);
  act(() => {
    nativeValueSetter().call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickSend(c: HTMLDivElement) {
  const button = [...c.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === "Send",
  );
  expect(button).not.toBeUndefined();
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("DescribeFirstWorkbench", () => {
  test("renders one prompt box — no heading, no label, no separate form", async () => {
    const c = await mount();
    expect(c.querySelector(".first-run-composer-input")).not.toBeNull();
    expect(c.querySelector("form")).toBeNull();
    expect(c.querySelector("h1")).toBeNull();
    expect(c.querySelector("label")).toBeNull();
    const input = composerInput(c);
    expect(input.hasAttribute("required")).toBe(false);
    const send = [...c.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Send",
    );
    expect(send?.disabled).toBe(true);
  });

  test("an empty send is a no-op — nothing fires, nothing changes", async () => {
    const c = await mount();
    clickSend(c);
    await settle();
    expect(c.textContent).not.toContain("Creating your workbench");
    expect(c.querySelector(".chat-composer-error")).toBeNull();
  });

  test("sending a message drafts, deploys, and navigates into the fresh conversation", async () => {
    let draftBody: Record<string, unknown> | undefined;
    let createBody: Record<string, unknown> | undefined;
    stubFetch({
      draft: (body) => {
        draftBody = body;
        return json(
          {
            draft: {
              systemPrompt: "You track competitor moves and report back.",
            },
          },
          201,
        );
      },
      create: (body) => {
        createBody = body;
        return json(CREATED_DEFINITION, 201);
      },
    });

    const navigated: string[] = [];
    const c = await mount((to) => navigated.push(to));
    typeMessage(c, "A weekly digest of competitor moves");
    clickSend(c);
    await settle();
    await settle();

    expect(draftBody?.purpose).toBe("A weekly digest of competitor moves");
    expect(createBody?.systemPrompt).toBe(
      "You track competitor moves and report back.",
    );
    expect(navigated).toEqual(["/c/chan_new"]);
  });

  test("a drafting failure shows the real reason inline, message preserved for retry", async () => {
    stubFetch({
      draft: () =>
        json(
          {
            error: {
              code: "unavailable",
              message: "Myra is unavailable right now.",
            },
          },
          503,
        ),
    });

    const c = await mount();
    typeMessage(c, "A weekly digest of competitor moves");
    clickSend(c);
    await settle();
    await settle();

    expect(c.textContent).toContain("Myra is unavailable right now.");
    // Never a dead end — the message survives for a straight retry.
    expect(composerInput(c).value).toBe("A weekly digest of competitor moves");
    const send = [...c.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Send",
    );
    expect(send?.disabled).toBe(false);
  });

  test("a mint failure after a successful draft also shows inline, never a dead spinner", async () => {
    stubFetch({
      create: () =>
        json(
          { error: { code: "conflict", message: "That handle is taken." } },
          409,
        ),
    });

    const c = await mount();
    typeMessage(c, "A weekly digest of competitor moves");
    clickSend(c);
    await settle();
    await settle();

    expect(c.textContent).toContain("That handle is taken.");
    expect(composerInput(c).value).toBe("A weekly digest of competitor moves");
  });
});
