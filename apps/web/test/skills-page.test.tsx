// Skills (CL-6355), over the real registry (CL-5920). The page reads
// `/api/tenants/:id/skills` and its sub-paths, so every case here stubs
// `fetch` at that seam — no live hub, and no session-local skill store
// (that path is gone).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsPage } from "../src/pages/skills-page";
import { TestQueryProvider } from "./test-query-provider";

const TENANT = "tnt_1";

const TRIAGE = {
  assetId: "ast_1",
  name: "triage",
  description: "Sorts inbound issues.",
  scope: "private",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
};

type StubRoutes = Record<string, unknown>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let requested: { method: string; path: string; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

function stubRoutes(routes: StubRoutes): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requested.push({
      method,
      path,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response(
        JSON.stringify({ error: { message: `no stub for ${key}` } }),
        { status: 404 },
      );
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(
  props: {
    readonly tenantId?: string | null;
    readonly navigate?: (to: string) => void;
  } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <SkillsPage tenantId={TENANT} {...props} />
      </TestQueryProvider>,
    );
  });
  // Let the registry reads settle before asserting on rendered output.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const EMPTY_REGISTRY: StubRoutes = {
  [`GET /api/tenants/${TENANT}/skills`]: { skills: [] },
};

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
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SkillsPage", () => {
  test("renders the honest empty state when the registry has nothing", async () => {
    stubRoutes(EMPTY_REGISTRY);
    const el = await mount();
    expect(el.textContent).toContain("No skills yet");
    expect(el.textContent).toContain("reusable capability");
  });

  test("a failed registry read says so rather than showing an empty registry", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "hub is down" } }), {
        status: 503,
      })) as unknown as typeof fetch;
    const el = await mount();
    expect(el.textContent).toContain("Couldn't load your skills");
    expect(el.textContent).not.toContain("hub is down");
    expect(el.textContent).not.toContain("No skills yet");
  });

  test("lists published skills with their access state", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
    });
    const el = await mount();
    expect(el.textContent).toContain("triage");
    expect(el.textContent).toContain("Sorts inbound issues.");
    expect(el.textContent).toContain("Only me");
  });

  test("Create skill posts directly to the registry and opens the new skill's page", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`POST /api/tenants/${TENANT}/skills`]: {
        skill: { ...TRIAGE, name: "summarize" },
      },
    });
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });

    const newSkill = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New skill"),
    );
    await act(async () => {
      newSkill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      fillField("create-skill-name", "summarize");
      fillField("create-skill-description", "Condenses.", true);
      fillField("create-skill-body", "Do it.", true);
    });

    const create = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create skill",
    );
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const call = requested.find(
      (entry) => entry.method === "POST" && entry.path.endsWith("/skills"),
    );
    expect(call?.body).toEqual({
      name: "summarize",
      description: "Condenses.",
      body: "Do it.",
      scope: "private",
    });
    expect(navigated).toContain("/skills/summarize");
  });

  test("Upload SKILL.md posts its parsed source and opens the new skill's page", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`POST /api/tenants/${TENANT}/skills`]: {
        skill: { ...TRIAGE, name: "summarize" },
      },
    });
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });

    const newSkill = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New skill"),
    );
    await act(async () => {
      newSkill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const uploadTab = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='tab']"),
    ).find((tab) => tab.textContent === "Upload");
    await act(async () => {
      uploadTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const source = [
      "---",
      "name: summarize",
      "description: 'Condenses.'",
      "---",
      "",
      "Do it.",
      "",
    ].join("\n");
    const fileInput = document.body.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const file = new File([source], "SKILL.md", { type: "text/markdown" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        value: transfer.files,
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const create = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create skill",
    );
    expect(create?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const call = requested.find(
      (entry) => entry.method === "POST" && entry.path.endsWith("/skills"),
    );
    expect(call?.body).toEqual({ source, scope: "private" });
    expect(navigated).toContain("/skills/summarize");
  });

  test("uploading a malformed SKILL.md surfaces the parse error and creates nothing", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requested.push({
        method,
        path,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (method === "POST" && path.endsWith("/skills")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "SKILL.md is missing its YAML frontmatter delimiter",
            },
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ skills: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const el = await mount();
    const newSkill = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New skill"),
    );
    await act(async () => {
      newSkill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const uploadTab = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='tab']"),
    ).find((tab) => tab.textContent === "Upload");
    await act(async () => {
      uploadTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const fileInput = document.body.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["not a skill file"], "SKILL.md", {
      type: "text/markdown",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        value: transfer.files,
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const create = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create skill",
    );
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "SKILL.md is missing its YAML frontmatter delimiter",
    );
    expect(
      requested.some(
        (entry) => entry.method === "POST" && entry.path.endsWith("/skills"),
      ),
    ).toBe(true);
  });

  test("a rejected create surfaces the registry's error inline in the dialog and creates nothing", async () => {
    // The dialog's own client-side validationIssues() never checks the
    // description for HTML, so an author typing markup only gets caught
    // server-side. That's the realistic path exercised here: the stubbed
    // 400 body is the exact plain-language message
    // `assertDescription` in packages/skills/src/registry.ts produces for
    // a description containing an HTML tag ("Description can't contain
    // HTML tags."), not an invented string — regression coverage against
    // that message drifting or an arktype regex summary leaking back in.
    const REGISTRY_DESCRIPTION_ERROR = "Description can't contain HTML tags.";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requested.push({
        method,
        path,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (method === "POST" && path.endsWith("/skills")) {
        return new Response(
          JSON.stringify({ error: { message: REGISTRY_DESCRIPTION_ERROR } }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ skills: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const el = await mount();
    const newSkill = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New skill"),
    );
    await act(async () => {
      newSkill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      fillField("create-skill-name", "summarize");
      fillField("create-skill-description", "<b>Condenses.</b>", true);
      fillField("create-skill-body", "Do it.", true);
    });

    const create = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create skill",
    );
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(REGISTRY_DESCRIPTION_ERROR);
    // The dialog is still open with the typed values rather than closed.
    expect(document.body.textContent).toContain("Create skill");
    expect(
      requested.filter(
        (entry) => entry.method === "POST" && entry.path.endsWith("/skills"),
      ),
    ).toHaveLength(1);
  });

  test("opening a row leaves the roster listed — a skill is never rendered inline", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
    });
    const el = await mount({ navigate: () => undefined });
    const row = Array.from(el.querySelectorAll("tr")).find((tr) =>
      tr.textContent?.includes("triage"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector('table[aria-label="Skills"]')).not.toBeNull();
    expect(el.textContent).not.toContain("Version history");
    expect(
      requested.some((entry) => entry.path.endsWith("/skills/triage")),
    ).toBe(false);
  });

  test("navigate is called with the skill's name when a row is selected", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
    });
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });
    const row = Array.from(el.querySelectorAll("tr")).find((tr) =>
      tr.textContent?.includes("triage"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toContain("/skills/triage");
  });
});

describe("CreateSkillDialog validation", () => {
  test("an empty form names every missing field in plain language", () => {
    expect(validationIssues({ name: "", description: "", body: "" })).toEqual([
      "Name is required.",
      "Description is required.",
      "Skill body is required.",
    ]);
  });

  test("a name the registry could never carry is rejected before submit", () => {
    expect(
      validationIssues({
        name: "Summarize Transcript",
        description: "x",
        body: "do the thing",
      }),
    ).toEqual([
      "Name must be lowercase letters, digits, and hyphens — no whitespace or capitals.",
    ]);
  });

  test("a complete form has no validation issues", () => {
    expect(
      validationIssues({
        name: "summarize",
        description: "x",
        body: "do the thing",
      }),
    ).toEqual([]);
  });
});
