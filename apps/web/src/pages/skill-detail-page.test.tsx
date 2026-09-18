// The skill detail page at /skills/<name> (rescoped by):
// the workbench-specific skill registry is gone, so the page renders what
// the stock skill-asset routes carry — the display title, the updated note,
// and an honest placeholder where the SKILL.md content, version history,
// pins, and scope toggle used to live. Every case stubs `fetch` at that
// stock seam (`/api/tenants/:id/assets?kind=skill&inherited=false`) — no
// live server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SkillDetailPage } from "./skill-detail-page";

const TENANT = "tnt_1";
const NAME = "triage";

const TRIAGE_ASSET = {
  id: "ast_1",
  tenantId: TENANT,
  kind: "skill",
  name: NAME,
  displayName: "Triage",
  creatorPrincipalId: "prn_1",
  createdAt: "2026-08-05T11:00:00.000Z",
  updatedAt: "2026-08-05T11:00:00.000Z",
};

const LIST_PATH = `/api/tenants/${TENANT}/assets?kind=skill&inherited=false`;

type Route = { readonly status: number; readonly body: unknown };

let routes: Record<string, Route> = {};
let requested: { method: string; path: string }[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

function stubRoutes(next: Record<string, Route>): void {
  routes = next;
  requested = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    requested.push({ method: init?.method ?? "GET", path });
    const route = routes[`${init?.method ?? "GET"} ${path}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { message: "no stub" } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = null;
  root = null;
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

async function mount(props: {
  readonly tenantId?: string | null;
  readonly name?: string;
}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SkillDetailPage
        tenantId={props.tenantId === undefined ? TENANT : props.tenantId}
        name={props.name ?? NAME}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
  });
  await settle();
  if (container === null) throw new Error("mount left no container");
  return container;
}

describe("SkillDetailPage", () => {
  test("renders the display title with its updated note and the content placeholder", async () => {
    stubRoutes({ [`GET ${LIST_PATH}`]: { status: 200, body: [TRIAGE_ASSET] } });
    const el = await mount({});
    // Title is the display name, not the raw kebab slug.
    expect(el.querySelector("h1")?.textContent?.trim()).toBe("Triage");
    expect(el.textContent).toContain("Updated");
    // The editor, version history, pins, and scope toggle lived in the
    // deleted registry — none of that renders here.
    expect(el.querySelector("#skill-body")).toBeNull();
    expect(el.querySelector('table[aria-label="Versions"]')).toBeNull();
    expect(el.textContent).not.toContain("Version history");
    expect(el.textContent).toContain("Skill content");
    expect(el.textContent).toContain("Not readable here yet");
  });

  test("a kebab skill name without a displayName is shown title-cased", async () => {
    const kebab = "writing-system-prompts";
    stubRoutes({
      [`GET ${LIST_PATH}`]: {
        status: 200,
        body: [{ ...TRIAGE_ASSET, name: kebab, displayName: null }],
      },
    });
    const el = await mount({ name: kebab });
    expect(el.querySelector("h1")?.textContent?.trim()).toBe("Writing System Prompts");
  });

  test("a name the roster doesn't carry renders the missing empty state", async () => {
    stubRoutes({ [`GET ${LIST_PATH}`]: { status: 200, body: [TRIAGE_ASSET] } });
    const el = await mount({ name: "gone-private" });
    expect(el.textContent).toContain("No skill named “gone-private”");
    expect(el.textContent).toContain("Back to Skills");
  });

  test("a failed list read renders the error state with a retry that re-reads", async () => {
    stubRoutes({
      [`GET ${LIST_PATH}`]: {
        status: 500,
        body: { error: { code: "boom", message: "The hub fell over." } },
      },
    });
    const el = await mount({});
    expect(el.textContent).toContain("Couldn't load this skill");
    // describeApiError deliberately never surfaces raw server text — the
    // page shows its generic copy for the 500 instead.
    expect(el.textContent).toContain("Something went wrong loading this skill.");
    expect(el.textContent).not.toContain("The hub fell over.");
    const reads = () => requested.filter((entry) => entry.path === LIST_PATH).length;
    expect(reads()).toBe(1);
    const retry = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(reads()).toBe(2);
  });

  test("without a workbench the page asks for one instead of reading", async () => {
    stubRoutes({ [`GET ${LIST_PATH}`]: { status: 200, body: [TRIAGE_ASSET] } });
    const el = await mount({ tenantId: null });
    expect(el.textContent).toContain("Pick a workbench to see this skill.");
    expect(requested).toEqual([]);
  });
});
