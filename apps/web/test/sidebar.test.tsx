// The one sidebar: create + search in the header, the workbench list as
// the entire body, and the activity band + switcher + utility row in a
// fixed footer region. It never renders a page-nav list and it has no
// collapse affordance.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { Sidebar } from "../src/shell/sidebar";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderSidebar(path: string): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <BenchProvider>
        <Sidebar path={path} user={user} onNavigate={noop} onSignOut={noop} />
      </BenchProvider>
    </TestQueryProvider>,
  );
}

const membership = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      tenantSlug: "corbits-bench",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(needsYou: unknown = { items: [] }): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/approvals/needs-you"))
      return Promise.resolve(json(needsYou));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/inbox/counts"))
      return Promise.resolve(
        json({ action: 1, mention: 0, delivery: 1, open: 2 }),
      );
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

describe("Sidebar", () => {
  test("header offers create + search; there is no collapse affordance", () => {
    const markup = renderSidebar("/c");
    expect(markup).toContain('aria-label="New workbench"');
    expect(markup).toContain('aria-label="Search"');
    expect(markup).not.toContain('aria-label="Collapse sidebar"');
    expect(markup).not.toContain('aria-label="Expand sidebar"');
  });

  test("titles itself Workbenches and never renders a page-nav list", () => {
    const markup = renderSidebar("/settings/agents");
    expect(markup).toContain(">Workbenches</h2>");
    expect(markup).not.toContain(">Pages<");
    expect(markup).not.toContain("shell-rail-item");
  });

  test("footer carries insights, the inbox bell, settings, and the account affordance", () => {
    const markup = renderSidebar("/c");
    expect(markup).toContain('aria-label="Insights"');
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).toContain("data-ctx-account");
  });

  test("marks the footer destination current for its own route only", () => {
    const onInsights = renderSidebar("/insights/runs");
    expect(onInsights).toMatch(/aria-label="Insights"[^>]*aria-current="page"/);
    const elsewhere = renderSidebar("/c");
    expect(elsewhere).not.toMatch(
      /aria-label="Insights"[^>]*aria-current="page"/,
    );
  });

  test("activity band slot sits between the scrollable body and the footer", async () => {
    stubFetch({
      items: [
        {
          id: "appr_1",
          headline: "Write to Firecrawl",
          agentName: "Myra",
          benchName: "Corbits Bench",
          arguments: {},
        },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <Sidebar path="/c" user={user} onNavigate={noop} onSignOut={noop} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("panel-band-activity")) break;
    }

    const slot = container.querySelector(".panel-activity-slot");
    const body = container.querySelector('[data-slot="sidebar-panel-body"]');
    const footer = container.querySelector(
      '[data-slot="sidebar-panel-footer"]',
    );
    expect(slot).not.toBeNull();
    expect(slot?.querySelector(".panel-band-activity")).not.toBeNull();
    expect(body?.contains(slot ?? document.body)).toBe(false);
    const position = slot?.compareDocumentPosition(body ?? document.body);
    const positionFooter = slot?.compareDocumentPosition(
      footer ?? document.body,
    );
    expect((position ?? 0) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(
      (positionFooter ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => root.unmount());
    container.remove();
  });

  test("shows an honest empty state once no scope resolves", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL) =>
      Promise.resolve(json({ data: [], nextCursor: null }))) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <Sidebar path="/c" user={user} onNavigate={noop} onSignOut={noop} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("Nothing selected")) break;
    }
    expect(container.innerHTML).toContain("Nothing selected");
    act(() => root.unmount());
    container.remove();
  });

  // CL-6124: a bench with zero workbenches lands on the first-run chat
  // (`/`), and the sidebar names it as a single active row — never the
  // icon "No workbenches yet" empty state, since the create-a-workbench
  // surface IS this screen now.
  test("zero workbenches: a single New Workbench row, styled active, not an icon empty state", async () => {
    stubFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <Sidebar path="/" user={user} onNavigate={noop} onSignOut={noop} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("shell-ch-row")) break;
    }
    const row = container.querySelector('.shell-ch-row[data-active="true"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("New Workbench");
    expect(container.innerHTML).not.toContain("No workbenches yet");
    act(() => root.unmount());
    container.remove();
  });

  // CL-6105: the footer avatar used to be a plain link straight to
  // settings — there was no way to sign out short of the hidden
  // right-click context menu. It is now a real menu (react-ui's `Menu`
  // primitives).
  //
  // CL-6132: grown to the reference shape — the whole account row (avatar
  // + name) is the trigger, and the menu itself carries a weekly usage
  // line, Settings, a feedback link out to the repo's GitHub issues, a
  // divider, and a danger-styled "Log out".
  describe("the account menu", () => {
    async function openAccountMenu(
      container: HTMLDivElement,
      onSignOut: () => void = noop,
    ): Promise<ReturnType<typeof createRoot>> {
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <TestQueryProvider>
            <BenchProvider>
              <Sidebar
                path="/c"
                user={user}
                onNavigate={noop}
                onSignOut={onSignOut}
              />
            </BenchProvider>
          </TestQueryProvider>,
        );
      });

      const trigger = container.querySelector<HTMLButtonElement>(
        ".shell-sidebar-account-btn",
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.textContent).toContain(user.name);
      await act(async () => {
        // Radix's dropdown-menu trigger opens on `pointerdown`, not
        // `click` — mirroring how a real mouse interaction reaches it.
        trigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      return root;
    }

    test("the whole avatar + name row opens the menu, popping upward", async () => {
      stubFetch();
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = await openAccountMenu(container);

      // Radix portals menu content onto `document.body`, outside this
      // test's own `container`.
      const menu = document.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      expect(menu?.getAttribute("data-side")).toBe("top");

      act(() => root.unmount());
      container.remove();
    });

    test("offers a Weekly usage line, Settings, a feedback link, and Log out", async () => {
      stubFetch();
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = await openAccountMenu(container);

      const menu = document.querySelector('[role="menu"]');
      expect(menu?.textContent).toContain("Weekly usage");
      expect(menu?.textContent).toContain("Settings");
      expect(menu?.textContent).toContain("Send Feedback");
      expect(menu?.textContent).toContain("Log out");

      const feedbackLink = menu?.querySelector<HTMLAnchorElement>(
        'a[href*="github.com/corbitsdev/workbench"]',
      );
      expect(feedbackLink).not.toBeUndefined();
      expect(feedbackLink?.getAttribute("href")).toContain("/issues");
      expect(feedbackLink?.getAttribute("target")).toBe("_blank");

      act(() => root.unmount());
      container.remove();
    });

    test("Log out is danger-styled and calls onSignOut", async () => {
      stubFetch();
      const container = document.createElement("div");
      document.body.appendChild(container);
      let signedOut = false;
      const root = await openAccountMenu(container, () => {
        signedOut = true;
      });

      const logOutItem = [
        ...document.querySelectorAll('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes("Log out") === true);
      expect(logOutItem).not.toBeUndefined();
      expect(logOutItem?.className).toContain("text-destructive");

      await act(async () => {
        logOutItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(signedOut).toBe(true);

      act(() => root.unmount());
      container.remove();
    });
  });
});
