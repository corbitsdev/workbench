// The skill detail page at /skills/<name> (CL-6416): the editor, the
// diff-confirmed save, the version list, compare, and restore. Every case
// stubs `fetch` at the registry seam the page reads
// (`/api/tenants/:id/skills/...`) — no live server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SkillDetailPage } from "../src/pages/skill-detail-page";
import { TestQueryProvider } from "./test-query-provider";

const TENANT = "tnt_1";
const NAME = "triage";
const HEAD_BODY = "Read the report.\nPick one label.";

const SKILL = {
  assetId: "ast_1",
  name: NAME,
  description: "Sorts inbound issues.",
  scope: "private",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
  body: HEAD_BODY,
};

const VERSIONS = [
  {
    commitSha: "abcdef1234",
    message: "Update triage",
    author: "Ada",
    committedAtIso: "2026-08-05T11:00:00.000Z",
    current: true,
  },
  {
    commitSha: "0123456789",
    message: "Create triage",
    author: "Grace",
    committedAtIso: "2026-08-04T11:00:00.000Z",
    current: false,
  },
];

const BASE = `/api/tenants/${TENANT}/skills/${NAME}`;

const ROUTES: Record<string, unknown> = {
  [`GET ${BASE}`]: {
    skill: SKILL,
    pinnedBy: [{ definitionId: "def_1", name: "Research Buddy" }],
  },
  [`GET ${BASE}/versions`]: { versions: VERSIONS },
  [`GET ${BASE}/versions/0123456789`]: {
    skill: { ...SKILL, body: "Read the report." },
  },
  [`PUT ${BASE}`]: { skill: SKILL },
  [`POST ${BASE}/restore`]: { skill: SKILL },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let requested: { method: string; path: string; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

function stubRegistry(): void {
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
    if (!(key in ROUTES)) {
      return new Response(
        JSON.stringify({ error: { message: `no stub for ${key}` } }),
        { status: 404 },
      );
    }
    return new Response(JSON.stringify(ROUTES[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
  stubRegistry();
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <SkillDetailPage
          tenantId={TENANT}
          name={NAME}
          now={Date.parse("2026-08-05T12:00:00.000Z")}
        />
      </TestQueryProvider>,
    );
  });
  await settle();
  if (container === null) throw new Error("container went away");
  return container;
}

function buttonsIn(scope: ParentNode): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button"));
}

function buttonNamed(scope: ParentNode, label: string): HTMLButtonElement {
  const found = buttonsIn(scope).find((button) =>
    button.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function typeInto(id: string, value: string) {
  const el = document.getElementById(id) as HTMLTextAreaElement | null;
  if (el === null) throw new Error(`no field #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no native value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function saves(): { method: string; path: string; body: unknown }[] {
  return requested.filter(
    (entry) => entry.method === "PUT" && entry.path === BASE,
  );
}

describe("SkillDetailPage", () => {
  test("renders the editor seeded from the published version, with its pins", async () => {
    const el = await mount();
    const body = document.getElementById(
      "skill-body",
    ) as HTMLTextAreaElement | null;
    expect(body?.value).toBe(HEAD_BODY);
    expect(el.textContent).toContain("Research Buddy");
  });

  test("the version list renders each commit's note, author, and when", async () => {
    const el = await mount();
    const table = el.querySelector('table[aria-label="Versions"]');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("Create triage");
    expect(table?.textContent).toContain("Grace");
    expect(table?.textContent).toContain("Version 1");
    expect(table?.textContent).toContain("current");
  });

  test("Save… is offered only once the editor differs from the published version", async () => {
    const el = await mount();
    const bar = el.querySelector('[data-testid="stage-top-bar-actions"]');
    expect(bar).not.toBeNull();
    if (bar === null) return;
    expect(buttonNamed(bar, "Save…").disabled).toBe(true);

    await act(async () => {
      typeInto("skill-body", `${HEAD_BODY}\nEscalate anything on fire.`);
    });
    expect(buttonNamed(bar, "Save…").disabled).toBe(false);
  });

  test("Save… opens a confirmation showing the diff, and writes nothing yet", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));

    expect(document.body.textContent).toContain("Review this save");
    const diff = document.body.querySelector('[data-testid="diff-view"]');
    expect(diff).not.toBeNull();
    expect(diff?.textContent).toContain("Pick one label.");
    expect(diff?.textContent).toContain("Pick two labels.");
    expect(saves()).toHaveLength(0);
  });

  test("Keep editing closes the review with the edit intact and nothing written", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Keep editing"));

    expect(document.body.textContent).not.toContain("Review this save");
    expect(saves()).toHaveLength(0);
    const body = document.getElementById(
      "skill-body",
    ) as HTMLTextAreaElement | null;
    expect(body?.value).toBe("Read the report.\nPick two labels.");
  });

  test("Confirm & save is what publishes the new version", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Confirm & save"));

    expect(saves()).toHaveLength(1);
    expect(saves()[0]?.body).toEqual({
      description: "Sorts inbound issues.",
      body: "Read the report.\nPick two labels.",
    });
  });

  test("Compare reads the chosen version and diffs it against the current one", async () => {
    const el = await mount();
    const table = el.querySelector('table[aria-label="Versions"]');
    if (table === null) throw new Error("no version table");
    const compares = buttonsIn(table).filter(
      (button) => button.textContent?.includes("Compare") && !button.disabled,
    );
    expect(compares).toHaveLength(1);
    await click(compares[0] as HTMLButtonElement);

    expect(
      requested.some((entry) => entry.path === `${BASE}/versions/0123456789`),
    ).toBe(true);
    expect(el.textContent).toContain("compared with the current version");
    expect(el.textContent).toContain("Pick one label.");
  });

  test("Restore posts the chosen commit to the registry", async () => {
    const el = await mount();
    const table = el.querySelector('table[aria-label="Versions"]');
    if (table === null) throw new Error("no version table");
    const restores = buttonsIn(table).filter(
      (button) => button.textContent === "Restore" && !button.disabled,
    );
    expect(restores).toHaveLength(1);
    await click(restores[0] as HTMLButtonElement);

    const call = requested.find((entry) => entry.path === `${BASE}/restore`);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ commitSha: "0123456789" });
  });

  test("a failed read says so rather than showing an empty editor", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "registry is down" } }), {
        status: 503,
      })) as unknown as typeof fetch;
    const el = await mount();
    expect(el.textContent).toContain("Couldn't load this skill");
    expect(el.textContent).not.toContain("registry is down");
  });
});
