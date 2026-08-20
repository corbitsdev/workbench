// The one sidebar: create + search in the header, the workbench list as
// the entire body, and the utility row in a fixed footer region. It never
// renders a page-nav list, an approvals/activity band, or a collapse
// affordance.

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

function stubFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: [] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

describe("Sidebar", () => {
  test("header offers create + search; there is no collapse affordance", () => {
    const markup = renderSidebar("/w");
    expect(markup).toContain('aria-label="New workbench"');
    // Search is the box inside the list (below the brand row), never a
    // header icon — the box itself is covered by the workbench-list tests.
    expect(markup).not.toContain('aria-label="Search"');
    expect(markup).not.toContain('aria-label="Collapse sidebar"');
    expect(markup).not.toContain('aria-label="Expand sidebar"');
  });

  // CL-6342: the "+" control opens the template picker (`/new`) instead of
  // minting a workbench directly.
  test("the + control opens the template picker, not an instant mint", async () => {
    stubFetch();
    const navigated: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <BenchProvider>
            <Sidebar
              path="/w"
              user={user}
              onNavigate={(to) => navigated.push(to)}
              onSignOut={noop}
            />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });

    const newButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="New workbench"]',
    );
    await act(async () => {
      newButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toEqual(["/new"]);

    act(() => root.unmount());
    container.remove();
  });

  test("titles itself Workbenches and never renders a page-nav list", () => {
    const markup = renderSidebar("/settings/agents");
    // The visible "Workbenches" label lives inside the list (below its
    // search box); the panel keeps the accessible name.
    expect(markup).toContain('aria-label="Workbenches"');
    expect(markup).not.toContain(">Pages<");
    expect(markup).not.toContain("shell-rail-item");
  });

  test("footer is Routines, Files, Skills, Agents, Plugins, Insights, then the account row — no Inbox", () => {
    const markup = renderSidebar("/w");
    expect(markup).toContain("shell-sidebar-footer-row");
    expect(markup).toContain(">Routines<");
    expect(markup).toContain(">Files<");
    expect(markup).toContain(">Skills<");
    expect(markup).toContain(">Agents<");
    expect(markup).toContain(">Plugins<");
    expect(markup).toContain(">Insights<");
    expect(markup).toContain("data-ctx-account");
    expect(markup).not.toContain(">Inbox<");
    expect(markup).not.toContain('aria-label="Notifications"');
    // Settings stays in the account menu, not a standalone footer icon.
    expect(markup).not.toContain('aria-label="Settings"');
    // Routines is first — CL-6362 gives it the same top-level rail slot
    // as every other global surface.
    expect(markup.indexOf(">Routines<")).toBeLessThan(
      markup.indexOf(">Files<"),
    );
  });

  test("marks the Routines row current for its own route only", () => {
    const onRoutines = renderSidebar("/routines");
    expect(onRoutines).toMatch(
      /shell-sidebar-footer-row"[^>]*data-active="true"[^>]*>[\s\S]*?>Routines</,
    );
    const elsewhere = renderSidebar("/w");
    expect(elsewhere).not.toMatch(/>Routines<[\s\S]{0,80}aria-current="page"/);
  });

  test("marks the Plugins row current for its own route only", () => {
    const onPlugins = renderSidebar("/plugins");
    expect(onPlugins).toMatch(
      /shell-sidebar-footer-row"[^>]*aria-current="page"/,
    );
    const elsewhere = renderSidebar("/w");
    expect(elsewhere).not.toMatch(
      /shell-sidebar-footer-row"[^>]*aria-current="page"/,
    );
  });

  // CL-6178: the global pages (Plugins, Insights) used to be the one place
  // the sidebar dropped the workbench list — reaching a conversation from
  // there took an extra hop back through `/`. The list is not page-scoped
  // (see `workbench-list.tsx`'s own header comment), so it renders exactly
  // the same on these routes as it does on a chat route, just with no row
  // marked active.
  describe("the workbench list on global pages", () => {
    const workbench = {
      id: "ch_1",
      title: "Research brief",
      kind: "workbench",
      pinned: false,
      participants: [],
    };

    function stubWorkbenches(): void {
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : String(input);
        if (path.includes("/api/me/principals"))
          return Promise.resolve(json(membership));
        if (path.includes("/chat/workbenches?kind=workbench"))
          return Promise.resolve(json({ items: [workbench] }));
        if (path.includes("/chat/workbenches?kind=chat"))
          return Promise.resolve(json({ items: [] }));
        if (path.includes("/approvals/needs-you"))
          return Promise.resolve(json({ items: [] }));
        if (path.includes("/top-level-runs"))
          return Promise.resolve(json({ data: [], nextCursor: null }));
        if (path.includes("/agent-definitions/visible"))
          return Promise.resolve(json({ definitions: [] }));
        return Promise.resolve(json({ items: [] }));
      }) as typeof fetch;
    }

    async function mountAt(
      path: string,
      onNavigate: (to: string) => void = noop,
    ): Promise<{
      container: HTMLDivElement;
      root: ReturnType<typeof createRoot>;
    }> {
      stubWorkbenches();
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <TestQueryProvider>
            <BenchProvider>
              <Sidebar
                path={path}
                user={user}
                onNavigate={onNavigate}
                onSignOut={noop}
              />
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
      return { container, root };
    }

    for (const path of ["/plugins", "/insights"]) {
      test(`renders the same workbench rows on ${path} as on a chat route, with none active`, async () => {
        const { container, root } = await mountAt(path);

        expect(
          container.querySelector('[aria-label="Search workbenches"]'),
        ).not.toBeNull();
        const row = container.querySelector(".shell-ch-row");
        expect(row).not.toBeNull();
        expect(row?.textContent).toContain("Research brief");
        expect(
          container.querySelector('.shell-ch-row[data-active="true"]'),
        ).toBeNull();

        act(() => root.unmount());
        container.remove();
      });
    }

    test("selecting a row from a global page navigates to that conversation", async () => {
      const navigated: string[] = [];
      const { container, root } = await mountAt("/plugins", (to) =>
        navigated.push(to),
      );

      const row = container.querySelector<HTMLButtonElement>(".shell-ch-row");
      await act(async () => {
        row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(navigated).toEqual(["/w/ch_1"]);

      act(() => root.unmount());
      container.remove();
    });
  });

  // Sidebar = workbenches + conversational DMs only. Visible agent
  // definitions that have never been opened do not get a synthetic row.
  describe("agent DM rows", () => {
    const workbench = {
      id: "ch_1",
      title: "Research brief",
      kind: "workbench",
      pinned: false,
      participants: [],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    };
    const ownAgent = {
      id: "wfd_outreach",
      name: "Outreach",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      createdAt: "2026-01-05T00:00:00.000Z",
    };
    const inheritedAgent = {
      id: "wfd_ancestor_agent",
      name: "Researcher",
      tenantId: "tnt_ancestor",
      tenantName: "Corbits HQ",
      createdAt: "2026-01-02T00:00:00.000Z",
    };

    function stubAgentSidebar(): void {
      globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
        const path = typeof input === "string" ? input : String(input);
        if (path.includes("/api/me/principals"))
          return Promise.resolve(json(membership));
        if (path.includes("/chat/workbenches?kind=workbench"))
          return Promise.resolve(json({ items: [workbench] }));
        if (path.includes("/chat/workbenches?kind=chat"))
          return Promise.resolve(json({ items: [] }));
        if (path.includes("/agent-definitions/visible"))
          return Promise.resolve(
            json({ definitions: [ownAgent, inheritedAgent] }),
          );
        if (path.includes("/approvals/needs-you"))
          return Promise.resolve(json({ items: [] }));
        if (path.includes("/top-level-runs"))
          return Promise.resolve(json({ data: [], nextCursor: null }));
        return Promise.resolve(json({ items: [] }));
      }) as typeof fetch;
    }

    async function mountSidebar(
      onNavigate: (to: string) => void = noop,
    ): Promise<{
      container: HTMLDivElement;
      root: ReturnType<typeof createRoot>;
    }> {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <TestQueryProvider>
            <BenchProvider>
              <Sidebar
                path="/w"
                user={user}
                onNavigate={onNavigate}
                onSignOut={noop}
              />
            </BenchProvider>
          </TestQueryProvider>,
        );
      });
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (container.textContent?.includes("Research brief")) break;
      }
      return { container, root };
    }

    test("does not render a synthetic row for an unopened agent", async () => {
      stubAgentSidebar();
      const { container, root } = await mountSidebar();

      const labels = [...container.querySelectorAll(".shell-ch-row")].map(
        (row) => row.textContent ?? "",
      );
      expect(labels.some((label) => label.includes("Research brief"))).toBe(
        true,
      );
      expect(labels.some((label) => label.includes("Outreach"))).toBe(false);
      expect(labels.some((label) => label.includes("Researcher"))).toBe(false);
      expect(container.querySelector("[data-ctx-agent]")).toBeNull();

      act(() => root.unmount());
      container.remove();
    });
  });

  test("does not render the activity or approvals band", () => {
    const markup = renderSidebar("/w");
    expect(markup).not.toContain("panel-activity-slot");
    expect(markup).not.toContain("panel-band-activity");
    expect(markup).not.toContain('aria-label="Activity"');
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
            <Sidebar path="/w" user={user} onNavigate={noop} onSignOut={noop} />
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
                path="/w"
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
