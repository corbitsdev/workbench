// DOM coverage for the guided first-workbench describe screen (CL-6104,
// step three of onboarding's four): a brand-new bench with zero
// workbenches lands here (see `home-page.test.tsx` for the routing side
// of that), describes what it wants in one field, and submitting drives
// the same drafting machinery `CreateAgentPanel` uses
// (`draftAgentDefinition` → `createAgentDefinition` → `launchAgentChat`).
// A failure at any step in that chain shows the real reason inline with
// a retry, never a dead spinner.

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

function fillDescription(value: string) {
  const el = document.getElementById(
    "describe-first-workbench-input",
  ) as HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  if (el === null) return;
  act(() => {
    nativeValueSetter().call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm() {
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  act(() => {
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("DescribeFirstWorkbench", () => {
  test("renders one field and one primary action, nothing else", async () => {
    const c = await mount();
    expect(c.querySelector("#describe-first-workbench-input")).not.toBeNull();
    const submit = [...c.querySelectorAll("button")].find(
      (button) => button.textContent === "Create my workbench",
    );
    expect(submit).not.toBeUndefined();
    expect(submit?.disabled).toBe(true);
  });

  test("submitting a description drafts, deploys, and navigates into the fresh conversation", async () => {
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
    fillDescription("A weekly digest of competitor moves");
    submitForm();
    await settle();
    await settle();

    expect(draftBody?.purpose).toBe("A weekly digest of competitor moves");
    expect(createBody?.systemPrompt).toBe(
      "You track competitor moves and report back.",
    );
    expect(navigated).toEqual(["/c/chan_new"]);
    void c;
  });

  test("a drafting failure shows the real reason inline, with the field still usable to retry", async () => {
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
    fillDescription("A weekly digest of competitor moves");
    submitForm();
    await settle();
    await settle();

    expect(c.textContent).toContain("Couldn't create your workbench");
    expect(c.textContent).toContain("Myra is unavailable right now.");
    // Never a dead end — the field and action are both still there.
    const submit = [...c.querySelectorAll("button")].find(
      (button) => button.textContent === "Create my workbench",
    );
    expect(submit?.disabled).toBe(false);
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
    fillDescription("A weekly digest of competitor moves");
    submitForm();
    await settle();
    await settle();

    expect(c.textContent).toContain("That handle is taken.");
  });
});
