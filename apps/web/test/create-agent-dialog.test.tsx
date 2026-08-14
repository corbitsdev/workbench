// DOM-mounted coverage for the create-agent dialog's skills multi-select:
// picking and un-picking a skill updates the submitted create body, and a
// bench with no skills yet shows the honest empty state instead of a blank
// checkbox list.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CreateAgentDialog } from "../src/pages/create-agent-dialog";
import type { SkillSummary } from "../src/skills-api";

const realFetch = globalThis.fetch;

const SKILL_WEB_RESEARCH: SkillSummary = {
  assetId: "ast_1",
  name: "web-research",
  description: "Searches the web and summarizes findings",
  scope: "private",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
};

const SKILL_LONG_FORM: SkillSummary = {
  ...SKILL_WEB_RESEARCH,
  assetId: "ast_2",
  name: "long-form-write",
  description: "Drafts long-form documents",
};

/** Serves the picker's registry read; anything else falls to `onOther`. */
function stubRegistry(
  skills: readonly SkillSummary[],
  onOther: (input: unknown, init?: RequestInit) => Response = () =>
    new Response("{}", { status: 200 }),
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/skills")) {
      return Promise.resolve(
        new Response(JSON.stringify({ skills }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(onOther(input, init));
  }) as typeof fetch;
}

function json(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  stubRegistry([]);
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

async function mount(
  onCreated: (definition: { id: string }) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CreateAgentDialog
        open
        onOpenChange={() => {}}
        tenantId="tenant_1"
        models={[]}
        onCreated={onCreated}
      />,
    );
  });
  // Settle the picker's registry read before any assertion.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function nativeValueSetter(
  proto: HTMLInputElement | HTMLTextAreaElement,
): (this: HTMLInputElement | HTMLTextAreaElement, value: string) => void {
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) {
    throw new Error("native value setter unavailable in this DOM");
  }
  return setter;
}

function fillField(id: string, value: string, textarea = false) {
  const el = document.getElementById(id) as
    HTMLInputElement | HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  if (el === null) return;
  const setter = nativeValueSetter(
    textarea
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
  );
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CreateAgentDialog handle auto-derive", () => {
  test("handle slugifies from the typed name until the user edits it", async () => {
    await mount();
    fillField("create-agent-name", "Research Buddy");
    const handleInput = document.getElementById(
      "create-agent-handle",
    ) as HTMLInputElement;
    expect(handleInput.value).toBe("research-buddy");

    fillField("create-agent-name", "Research Buddy Two");
    expect(handleInput.value).toBe("research-buddy-two");
  });

  test("once the user edits the handle directly, name changes stop overriding it", async () => {
    await mount();
    fillField("create-agent-name", "Research Buddy");
    fillField("create-agent-handle", "custom-handle");

    fillField("create-agent-name", "Research Buddy Two");
    const handleInput = document.getElementById(
      "create-agent-handle",
    ) as HTMLInputElement;
    expect(handleInput.value).toBe("custom-handle");
  });
});

describe("CreateAgentDialog skills picker", () => {
  test("with no skills yet, shows the empty state instead of a checkbox list", async () => {
    await mount();
    expect(document.body.textContent).toContain("No skills yet");
  });

  test("a registry read failure says so rather than reading as no skills", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "hub is down" } }), {
          status: 503,
        }),
      )) as unknown as typeof fetch;
    await mount();
    expect(document.body.textContent).toContain("Could not load skills");
    expect(document.body.textContent).not.toContain("No skills yet");
  });

  test("checking a skill attaches it, submitting sends it in the create body", async () => {
    const captured: { body: { skills?: readonly string[] } | null } = {
      body: null,
    };
    stubRegistry([SKILL_WEB_RESEARCH, SKILL_LONG_FORM], (_input, init) => {
      captured.body = JSON.parse(String(init?.body)) as {
        skills?: readonly string[];
      };
      return json({
        id: "wfd_new",
        tenantId: "tenant_1",
        name: "Research Buddy",
        description: null,
        currentVersion: "1",
        status: "deployed",
        createdAt: "2026-08-05T11:00:00.000Z",
        updatedAt: "2026-08-05T11:00:00.000Z",
        skills: ["web-research"],
      });
    });

    let created: { id: string } | null = null;
    await mount((definition) => {
      created = definition;
    });

    fillField("create-agent-name", "Research Buddy");
    fillField("create-agent-handle", "research-buddy");
    fillField(
      "create-agent-systemPrompt",
      "You are a careful research assistant.",
      true,
    );

    const checkbox = [
      ...document.body.querySelectorAll('input[type="checkbox"]'),
    ].find((input) =>
      (input.closest("label")?.textContent ?? "").includes("web-research"),
    ) as HTMLInputElement | undefined;
    expect(checkbox).not.toBeUndefined();
    act(() => {
      checkbox?.click();
    });

    const createButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Create agent",
    );
    expect(createButton?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      createButton?.click();
      await Promise.resolve();
    });

    expect(captured.body?.skills).toEqual(["web-research"]);
    expect((created as { id: string } | null)?.id).toBe("wfd_new");
  });

  test("unchecking a picked skill removes it before submit", async () => {
    stubRegistry([SKILL_WEB_RESEARCH]);
    await mount();
    fillField("create-agent-name", "Research Buddy");

    const checkbox = document.body.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(true);
    act(() => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(false);
  });
});
