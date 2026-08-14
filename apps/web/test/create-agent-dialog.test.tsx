// DOM-mounted coverage for the create-agent dialog's skills multi-select:
// picking and un-picking a skill updates the submitted create body, and a
// bench with no skills yet shows the honest empty state instead of a blank
// checkbox list.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CreateAgentDialog } from "../src/pages/create-agent-dialog";
import { resetSessionSkills, type Skill } from "../src/skills-session";

const realFetch = globalThis.fetch;

const SKILL_WEB_RESEARCH: Skill = {
  id: "skl_1",
  name: "Web research",
  description: "Searches the web and summarizes findings",
  body: "",
  access: "Private",
  owner: "You",
  updatedAt: "2026-08-05T11:00:00.000Z",
  version: "0.1.0",
  pinnedBy: [],
  versions: [],
  sessionLocal: true,
};

const SKILL_LONG_FORM: Skill = {
  ...SKILL_WEB_RESEARCH,
  id: "skl_2",
  name: "Long-form write",
  description: "Drafts long-form documents",
};

function json(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  resetSessionSkills([]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSessionSkills([]);
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function mount(onCreated: (definition: { id: string }) => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
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
  test("handle slugifies from the typed name until the user edits it", () => {
    mount();
    fillField("create-agent-name", "Research Buddy");
    const handleInput = document.getElementById(
      "create-agent-handle",
    ) as HTMLInputElement;
    expect(handleInput.value).toBe("research-buddy");

    fillField("create-agent-name", "Research Buddy Two");
    expect(handleInput.value).toBe("research-buddy-two");
  });

  test("once the user edits the handle directly, name changes stop overriding it", () => {
    mount();
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
  test("with no skills yet, shows the empty state instead of a checkbox list", () => {
    mount();
    expect(document.body.textContent).toContain("No skills yet");
  });

  test("checking a skill attaches it, submitting sends it in the create body", async () => {
    resetSessionSkills([SKILL_WEB_RESEARCH, SKILL_LONG_FORM]);
    const captured: { body: { skills?: readonly string[] } | null } = {
      body: null,
    };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as {
        skills?: readonly string[];
      };
      void input;
      return Promise.resolve(
        json({
          id: "wfd_new",
          tenantId: "tenant_1",
          name: "Research Buddy",
          description: null,
          currentVersion: "1",
          status: "deployed",
          createdAt: "2026-08-05T11:00:00.000Z",
          updatedAt: "2026-08-05T11:00:00.000Z",
          skills: ["Web research"],
        }),
      );
    }) as typeof fetch;

    let created: { id: string } | null = null;
    mount((definition) => {
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
      (input.closest("label")?.textContent ?? "").includes("Web research"),
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

    expect(captured.body?.skills).toEqual(["Web research"]);
    expect((created as { id: string } | null)?.id).toBe("wfd_new");
  });

  test("unchecking a picked skill removes it before submit", () => {
    resetSessionSkills([SKILL_WEB_RESEARCH]);
    mount();
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
