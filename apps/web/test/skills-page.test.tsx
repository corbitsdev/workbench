// Skills (CL-6355), over the native skill assets (CL-8086). The page reads
// the stock asset routes (`GET /api/tenants/:id/assets?kind=skill` for the
// roster, `POST` for create), so every case here stubs `fetch` at that seam
// — no live hub, and no workbench-local skill registry (that path is gone).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsPage } from "../src/pages/skills-page";
import { TestQueryProvider } from "./test-query-provider";

const TENANT = "tnt_1";

const TRIAGE_ASSET = {
  id: "ast_1",
  tenantId: "tnt_1",
  kind: "skill",
  name: "triage",
  displayName: "Triage",
  creatorPrincipalId: "prn_1",
  createdAt: "2026-08-05T11:00:00.000Z",
  updatedAt: "2026-08-05T11:00:00.000Z",
};

// The roster's one read: the stock asset list filtered to skill assets.
const LIST_PATH = `/api/tenants/${TENANT}/assets?kind=skill&inherited=false`;
const CREATE_PATH = `/api/tenants/${TENANT}/assets`;

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
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ error: { message: `no stub for ${key}` } }), {
        status: 404,
      });
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
  [`GET ${LIST_PATH}`]: [],
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
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  if (el === null) return;
  const setter = nativeValueSetter(
    textarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
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

  test("lists skills by display title — the stock routes carry no description or scope", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET ${LIST_PATH}`]: [TRIAGE_ASSET],
    });
    const el = await mount();
    // Name slot is a display title, never the raw kebab slug (CL-6747).
    expect(el.textContent).toContain("Triage");
    // Description and scope lived in the deleted registry: the roster must
    // not invent them from asset metadata.
    expect(el.textContent).not.toContain("Sorts inbound issues.");
    expect(el.textContent).not.toContain("Only me");
    expect(el.textContent).not.toContain("Everyone");
    expect(el.querySelector('[data-slot="badge"]')).toBeNull();
  });

  test("a kebab skill name without a displayName is shown title-cased in the Name column", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET ${LIST_PATH}`]: [
        {
          ...TRIAGE_ASSET,
          name: "writing-system-prompts",
          displayName: null,
        },
      ],
    });
    const el = await mount();
    expect(el.textContent).toContain("Writing System Prompts");
    const nameCell = Array.from(el.querySelectorAll("td")).find((cell) =>
      cell.textContent?.includes("Writing System Prompts"),
    );
    expect(nameCell?.textContent?.trim()).toBe("Writing System Prompts");
  });

  test("an explicit displayName wins over the title-cased slug", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET ${LIST_PATH}`]: [{ ...TRIAGE_ASSET, name: "summarize", displayName: "Summarize Now!" }],
    });
    const el = await mount();
    const nameCell = Array.from(el.querySelectorAll("td")).find((cell) =>
      cell.textContent?.includes("Summarize Now!"),
    );
    expect(nameCell?.textContent?.trim()).toBe("Summarize Now!");
  });

  test("Create skill posts a kind:skill asset and opens the new skill's page", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`POST ${CREATE_PATH}`]: {
        ...TRIAGE_ASSET,
        id: "skill_created",
        name: "summarize",
        displayName: "Summarize",
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
      fillField("create-skill-displayName", "Summarize");
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

    const call = requested.find((entry) => entry.method === "POST" && entry.path === CREATE_PATH);
    expect(call?.body).toEqual({
      kind: "skill",
      name: "summarize",
      displayName: "Summarize",
    });
    expect(navigated).toContain("/skills/summarize");
  });

  test("displayName is optional — omitting it posts kind and name only", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`POST ${CREATE_PATH}`]: {
        ...TRIAGE_ASSET,
        id: "skill_created",
        name: "summarize",
        displayName: null,
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

    const call = requested.find((entry) => entry.method === "POST" && entry.path === CREATE_PATH);
    expect(call?.body).toEqual({ kind: "skill", name: "summarize" });
    expect(navigated).toContain("/skills/summarize");
  });

  test("a rejected create surfaces the asset route's error inline in the dialog and creates nothing", async () => {
    // The dialog's own validationIssues() only checks the name, so a
    // server-side rejection is the realistic path exercised here: the
    // stubbed 400 body carries the stock error envelope's exact
    // plain-language message — regression coverage against that message
    // drifting or an arktype summary leaking back in.
    const ASSET_NAME_ERROR = "Name is taken.";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requested.push({
        method,
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (method === "POST" && path === CREATE_PATH) {
        return new Response(
          JSON.stringify({
            error: {
              code: "name_taken",
              message: ASSET_NAME_ERROR,
            },
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
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
      fillField("create-skill-displayName", "Summarize");
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

    expect(document.body.textContent).toContain(ASSET_NAME_ERROR);
    // The dialog is still open with the typed values rather than closed.
    expect(document.body.textContent).toContain("Create skill");
    expect(
      requested.filter((entry) => entry.method === "POST" && entry.path === CREATE_PATH),
    ).toHaveLength(1);
  });

  test("opening a row leaves the roster listed — a skill is never rendered inline", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET ${LIST_PATH}`]: [TRIAGE_ASSET],
    });
    const el = await mount({ navigate: () => undefined });
    const row = Array.from(el.querySelectorAll("tr")).find((tr) =>
      tr.textContent?.includes("Triage"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector('table[aria-label="Skills"]')).not.toBeNull();
    expect(el.textContent).not.toContain("Version history");
    // Opening a row navigates — it never issues a per-skill read.
    expect(requested.filter((entry) => entry.path !== LIST_PATH)).toEqual([]);
  });

  test("navigate is called with the skill's name when a row is selected", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET ${LIST_PATH}`]: [TRIAGE_ASSET],
    });
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });
    const row = Array.from(el.querySelectorAll("tr")).find((tr) =>
      tr.textContent?.includes("Triage"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toContain("/skills/triage");
  });
});

describe("CreateSkillDialog validation", () => {
  test("an empty form names every missing field in plain language", () => {
    expect(validationIssues({ name: "", displayName: "" })).toEqual(["Name is required."]);
  });

  test("a slug the asset routes could never carry is rejected before submit", () => {
    expect(
      validationIssues({
        name: "Summarize Transcript",
        displayName: "",
      }),
    ).toEqual(["Name must be lowercase letters, digits, and hyphens — no whitespace or capitals."]);
  });

  test("a complete form has no validation issues", () => {
    expect(
      validationIssues({
        name: "summarize",
        displayName: "Summarize",
      }),
    ).toEqual([]);
  });

  test("displayName stays optional — a bare name is submittable", () => {
    expect(validationIssues({ name: "summarize", displayName: "" })).toEqual([]);
  });
});
