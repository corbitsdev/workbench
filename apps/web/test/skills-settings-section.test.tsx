// Settings · Skills, over the real registry (CL-5920). The section
// reads `/api/tenants/:id/skills` and its sub-paths, so every case here
// stubs `fetch` at that seam — no live hub, and no session-local skill
// store (that path is gone).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { validationIssues } from "../src/pages/create-skill-dialog";
import { SkillsSettingsSection } from "../src/pages/skills-settings-section";
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

const PENDING_DRAFT = {
  assetId: "ast_2",
  name: "summarize",
  description: "Condenses a long thread.",
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
    readonly entityId?: string | null;
    readonly navigate?: (to: string) => void;
  } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <SkillsSettingsSection tenantId={TENANT} {...props} />
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
  [`GET /api/tenants/${TENANT}/skills/drafts`]: { drafts: [] },
};

describe("SkillsSettingsSection", () => {
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
    expect(el.textContent).toContain("Could not load the skill registry");
    expect(el.textContent).toContain("hub is down");
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
    expect(el.textContent).toContain("Private");
  });

  test("a pending draft is shown separately with a Publish action", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills/drafts`]: { drafts: [PENDING_DRAFT] },
    });
    const el = await mount();
    expect(el.textContent).toContain("Pending");
    expect(el.textContent).toContain("summarize");
    expect(el.textContent).toContain("Publish");
  });

  test("Publish converts the draft through the registry's publish endpoint", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills/drafts`]: { drafts: [PENDING_DRAFT] },
      [`POST /api/tenants/${TENANT}/skills/drafts/summarize/publish`]: {
        skill: { ...TRIAGE, name: "summarize" },
      },
      [`GET /api/tenants/${TENANT}/skills/summarize`]: {
        skill: { ...TRIAGE, name: "summarize", body: "Do it." },
        pinnedBy: [],
      },
      [`GET /api/tenants/${TENANT}/skills/summarize/versions`]: {
        versions: [],
      },
    });
    const el = await mount();
    const publish = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Publish",
    );
    await act(async () => {
      publish?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      requested.some(
        (call) =>
          call.method === "POST" &&
          call.path.endsWith("/skills/drafts/summarize/publish"),
      ),
    ).toBe(true);
  });

  test("entityId opens the skill's detail with its version history and pins", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
      [`GET /api/tenants/${TENANT}/skills/triage`]: {
        skill: { ...TRIAGE, body: "Pick exactly one label." },
        pinnedBy: [{ definitionId: "def_1", name: "Research Buddy" }],
      },
      [`GET /api/tenants/${TENANT}/skills/triage/versions`]: {
        versions: [
          {
            commitSha: "abcdef1234",
            message: "Publish triage",
            author: "workbench",
            committedAtIso: "2026-08-05T11:00:00.000Z",
            current: true,
          },
          {
            commitSha: "0123456789",
            message: "Draft triage",
            author: "workbench",
            committedAtIso: "2026-08-04T11:00:00.000Z",
            current: false,
          },
        ],
      },
    });
    const el = await mount({ entityId: "triage" });
    expect(el.textContent).toContain("Pick exactly one label.");
    expect(el.textContent).toContain("Research Buddy");
    expect(el.textContent).toContain("Publish triage");
    expect(el.textContent).toContain("Restore");
  });

  test("Restore posts the chosen commit to the registry", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
      [`GET /api/tenants/${TENANT}/skills/triage`]: {
        skill: { ...TRIAGE, body: "Pick exactly one label." },
        pinnedBy: [],
      },
      [`GET /api/tenants/${TENANT}/skills/triage/versions`]: {
        versions: [
          {
            commitSha: "abcdef1234",
            message: "Publish triage",
            author: "workbench",
            committedAtIso: "2026-08-05T11:00:00.000Z",
            current: true,
          },
          {
            commitSha: "0123456789",
            message: "Draft triage",
            author: "workbench",
            committedAtIso: "2026-08-04T11:00:00.000Z",
            current: false,
          },
        ],
      },
      [`POST /api/tenants/${TENANT}/skills/triage/restore`]: { skill: TRIAGE },
    });
    const el = await mount({ entityId: "triage" });
    const restore = Array.from(el.querySelectorAll("button")).filter(
      (button) => button.textContent === "Restore" && !button.disabled,
    );
    expect(restore).toHaveLength(1);
    await act(async () => {
      restore[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const call = requested.find((entry) =>
      entry.path.endsWith("/skills/triage/restore"),
    );
    expect(call?.body).toEqual({ commitSha: "0123456789" });
  });

  test("Install shares a private skill with the whole workbench", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
      [`GET /api/tenants/${TENANT}/skills/triage`]: {
        skill: { ...TRIAGE, body: "Pick exactly one label." },
        pinnedBy: [],
      },
      [`GET /api/tenants/${TENANT}/skills/triage/versions`]: { versions: [] },
      [`PUT /api/tenants/${TENANT}/skills/triage/scope`]: { skill: TRIAGE },
    });
    const el = await mount({ entityId: "triage" });
    const install = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Install",
    );
    await act(async () => {
      install?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const call = requested.find((entry) =>
      entry.path.endsWith("/skills/triage/scope"),
    );
    expect(call?.body).toEqual({ scope: "tenant" });
  });

  test("navigate is called with the skill's name when a row is selected", async () => {
    stubRoutes({
      ...EMPTY_REGISTRY,
      [`GET /api/tenants/${TENANT}/skills`]: { skills: [TRIAGE] },
      [`GET /api/tenants/${TENANT}/skills/triage`]: {
        skill: { ...TRIAGE, body: "Pick exactly one label." },
        pinnedBy: [],
      },
      [`GET /api/tenants/${TENANT}/skills/triage/versions`]: { versions: [] },
    });
    const navigated: string[] = [];
    const el = await mount({ navigate: (to) => navigated.push(to) });
    const row = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("triage"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toContain("/settings/skills/triage");
  });
});

describe("CreateSkillDialog validation", () => {
  test("an empty draft names every missing field in plain language", () => {
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
      "Name must be lowercase letters, digits, and hyphens — no spaces or capitals.",
    ]);
  });

  test("the reserved draft prefix is rejected", () => {
    expect(
      validationIssues({
        name: "draft-summarize",
        description: "x",
        body: "do the thing",
      }),
    ).toEqual([
      'Name cannot start with "draft-" — that prefix marks a pending draft.',
    ]);
  });

  test("a complete draft has no validation issues", () => {
    expect(
      validationIssues({
        name: "summarize",
        description: "x",
        body: "do the thing",
      }),
    ).toEqual([]);
  });
});
