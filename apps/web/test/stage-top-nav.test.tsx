// CL-6409: the shell's top-nav contract. A page declares where it sits with
// `StageTopBar`'s `crumbs` — a title trail whose every level above the
// current page is a real route — and puts its primary controls in the
// `actions` slot. This suite covers the trail's markup and navigation, the
// action slot, and the two reference adopters (Plugins, Skills) declaring
// their nav through it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationProvider } from "../src/navigation";
import { BenchProvider } from "../src/bench-context";
import { PluginsRoute } from "../src/pages/plugins-page";
import { SkillDetailPage } from "../src/pages/skill-detail-page";
import { SkillsPage } from "../src/pages/skills-page";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { StageTopBar } from "../src/shell/stage-top-bar";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;

/** The declaration block of the last rule that names `className`, so a test
 * can assert on the actual CSS the class carries. */
function ruleFor(css: string, className: string): string {
  const selector = new RegExp(`\\.${className}\\s*[,{]`);
  const block = css.split("}").find((candidate) => selector.test(candidate));
  if (block === undefined) throw new Error(`no rule for .${className}`);
  return block.slice(block.indexOf("{"));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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

async function render(node: React.ReactElement): Promise<HTMLDivElement> {
  await act(async () => {
    root?.render(node);
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (container === null) throw new Error("container missing");
  return container;
}

describe("stage breadcrumbs", () => {
  test("intermediate crumbs are links to their own route; the last crumb is the page title", () => {
    const markup = renderToStaticMarkup(
      <NavigationProvider navigate={noop}>
        <StageTopBar
          crumbs={[
            { label: "Skills", href: "/skills" },
            { label: "weekly-digest" },
          ]}
        />
      </NavigationProvider>,
    );
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/skills"');
    expect(markup).toContain('aria-current="page">weekly-digest</span>');
    // The current page is never a link.
    expect(markup).not.toContain('href="/skills/weekly-digest"');
  });

  test("a single-level page still declares its title as a trail", () => {
    const markup = renderToStaticMarkup(
      <NavigationProvider navigate={noop}>
        <StageTopBar crumbs={[{ label: "Plugins" }]} />
      </NavigationProvider>,
    );
    expect(markup).toContain('aria-current="page">Plugins</span>');
    expect(markup).not.toContain("<a ");
  });

  test("a one-level page renders no Breadcrumb landmark — there is nowhere to go up to", () => {
    const markup = renderToStaticMarkup(
      <NavigationProvider navigate={noop}>
        <StageTopBar crumbs={[{ label: "Files" }]} />
      </NavigationProvider>,
    );
    expect(markup).not.toContain('aria-label="Breadcrumb"');
    expect(markup).not.toContain("<nav");
  });

  test("every class the trail renders is truncation-capped by the stylesheet", () => {
    const markup = renderToStaticMarkup(
      <NavigationProvider navigate={noop}>
        <StageTopBar
          crumbs={[
            { label: "Files", href: "/files" },
            { label: "a".repeat(200) },
          ]}
        />
      </NavigationProvider>,
    );
    const css = readFileSync(
      new URL("../src/app.css", import.meta.url),
      "utf8",
    );
    for (const className of ["stage-crumb-link", "stage-crumb-current"]) {
      expect(markup).toContain(`class="${className}"`);
      const rule = ruleFor(css, className);
      expect(rule).toContain("overflow: hidden");
      expect(rule).toContain("text-overflow: ellipsis");
      expect(rule).toContain("min-width");
    }
    // The trail itself must be the part that gives, not the action slot.
    expect(ruleFor(css, "stage-crumbs")).toContain("min-width: 0");
    expect(ruleFor(css, "stage-top-bar-actions")).toContain("flex-shrink: 0");
  });

  test("clicking an intermediate crumb navigates in-app instead of reloading", async () => {
    const navigated: string[] = [];
    const el = await render(
      <NavigationProvider navigate={(to) => navigated.push(to)}>
        <StageTopBar
          crumbs={[
            { label: "Insights", href: "/insights" },
            { label: "Run history" },
          ]}
        />
      </NavigationProvider>,
    );
    const link = el.querySelector<HTMLAnchorElement>("a.stage-crumb-link");
    expect(link).not.toBeNull();
    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(navigated).toEqual(["/insights"]);
  });

  test("the action slot renders the page's own controls", () => {
    const markup = renderToStaticMarkup(
      <NavigationProvider navigate={noop}>
        <StageTopBar
          crumbs={[{ label: "Skills" }]}
          actions={<button type="button">New skill</button>}
        />
      </NavigationProvider>,
    );
    const actions = markup.slice(markup.indexOf("stage-top-bar-actions"));
    expect(actions).toContain("New skill");
  });
});

const TENANT = "tnt_1";

const SKILL = {
  assetId: "ast_1",
  name: "weekly-digest",
  description: "Summarizes the week.",
  scope: "private",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Skills declares its nav through the top-bar contract", () => {
  test("the list view titles itself and keeps New skill in the action slot, not the body", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/tenants/${TENANT}/skills`)
        return Promise.resolve(json({ skills: [SKILL] }));
      return Promise.resolve(json({ error: { message: "no stub" } }, 404));
    }) as typeof fetch;

    const el = await render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          <SkillsPage tenantId={TENANT} />
        </NavigationProvider>
      </TestQueryProvider>,
    );

    const bar = el.querySelector('[data-testid="stage-top-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Skills",
    );
    const actions = el.querySelector('[data-testid="stage-top-bar-actions"]');
    expect(actions?.textContent).toContain("New skill");
    expect(el.querySelector(".page-toolbar")).toBeNull();
  });

  test("an open skill deep-links its parent level back to /skills", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/tenants/${TENANT}/skills/weekly-digest`)
        return Promise.resolve(
          json({ skill: { ...SKILL, body: "Do it." }, pinnedBy: [] }),
        );
      if (path === `/api/tenants/${TENANT}/skills/weekly-digest/versions`)
        return Promise.resolve(json({ versions: [] }));
      return Promise.resolve(json({ error: { message: "no stub" } }, 404));
    }) as typeof fetch;

    const el = await render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          <SkillDetailPage tenantId={TENANT} name="weekly-digest" />
        </NavigationProvider>
      </TestQueryProvider>,
    );

    const trail = el.querySelector('nav[aria-label="Breadcrumb"]');
    expect(trail?.querySelector("a")?.getAttribute("href")).toBe("/skills");
    expect(trail?.querySelector('[aria-current="page"]')?.textContent).toBe(
      "weekly-digest",
    );
    expect(el.querySelector('table[aria-label="Skills"]')).toBeNull();
  });

  test("the parent crumb is the way back: clicking it navigates to /skills", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/tenants/${TENANT}/skills/weekly-digest`)
        return Promise.resolve(
          json({ skill: { ...SKILL, body: "Do it." }, pinnedBy: [] }),
        );
      if (path === `/api/tenants/${TENANT}/skills/weekly-digest/versions`)
        return Promise.resolve(json({ versions: [] }));
      return Promise.resolve(json({ error: { message: "no stub" } }, 404));
    }) as typeof fetch;

    const navigated: string[] = [];
    const el = await render(
      <TestQueryProvider>
        <NavigationProvider navigate={(to) => navigated.push(to)}>
          <SkillDetailPage tenantId={TENANT} name="weekly-digest" />
        </NavigationProvider>
      </TestQueryProvider>,
    );

    const parent = el.querySelector<HTMLAnchorElement>("a.stage-crumb-link");
    await act(async () => {
      parent?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(navigated).toContain("/skills");
  });
});

describe("Plugins declares its nav through the top-bar contract", () => {
  test("the gallery titles itself and keeps New skill in the action slot", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/me/principals"))
        return Promise.resolve(
          json({
            data: [
              {
                principalId: "prn_1",
                tenantId: TENANT,
                tenantName: "Corbits Bench",
                tenantSlug: "corbits-bench",
                kind: "user",
                status: "active",
                roles: [],
              },
            ],
            nextCursor: null,
          }),
        );
      if (path.includes("/api/workbench-tenancies/kinds"))
        return Promise.resolve(json({ workbenchTenantIds: [] }));
      if (path.includes("/connections/provider-health"))
        return Promise.resolve(
          json({ providers: {}, connectedProviderCount: 0 }),
        );
      if (path.includes("/credentials/resolve/"))
        return Promise.resolve(json(null, 404));
      if (path.includes(`/api/tenants/${TENANT}/skills`))
        return Promise.resolve(json({ skills: [SKILL] }));
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }) as typeof fetch;

    const el = await render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          <BenchProvider>
            <ProviderHealthProvider>
              <PluginsRoute path="/plugins" />
            </ProviderHealthProvider>
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );

    const bar = el.querySelector('[data-testid="stage-top-bar"]');
    expect(bar?.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Plugins",
    );

    const skillsTab = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Skills") === true,
    );
    await act(async () => {
      skillsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const actions = el.querySelector('[data-testid="stage-top-bar-actions"]');
    expect(actions?.textContent).toContain("New skill");
  });
});
