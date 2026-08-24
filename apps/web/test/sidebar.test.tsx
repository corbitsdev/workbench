// The one sidebar: create + search in the header, the workbench list as
// the entire body, and the utility row in a fixed footer region. It never
// renders a page-nav list, an approvals/activity band, or a collapse
// affordance.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { APP_ROUTES, NAV_ROUTES } from "../src/routes";
import { Sidebar } from "../src/shell/sidebar";
import { SIDEBAR_EMPTY_COPY } from "../src/shell/workbench-list";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyTokens = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  thinking: 0,
  total: 0,
};

function usageBody(turns: number): unknown {
  return {
    turns,
    tokens: { ...emptyTokens, total: turns },
    costUsd: turns > 0 ? 1.25 : 0,
    byModel: [],
  };
}

const oneEvalRun = {
  id: "evalrun_1",
  evalName: "factory",
  evalDescription: null,
  configName: "default",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:02:00.000Z",
  stepCount: 1,
  scorerTally: { passed: 1, failed: 0, skipped: 0 },
};

function stubFetch(options?: {
  readonly usageTurns?: number;
  readonly evalRuns?: boolean;
  readonly failUsage?: boolean;
  readonly failEvals?: boolean;
}): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: [] }));
    if (path.includes("/insights/usage")) {
      if (options?.failUsage === true)
        return Promise.resolve(json({ error: "unavailable" }, 500));
      return Promise.resolve(json(usageBody(options?.usageTurns ?? 0)));
    }
    if (path.includes("/eval-runs/runs")) {
      if (options?.failEvals === true)
        return Promise.resolve(json({ error: "unavailable" }, 500));
      return Promise.resolve(
        json({ runs: options?.evalRuns === true ? [oneEvalRun] : [] }),
      );
    }
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function footerRowLabelsFromMarkup(markup: string): string[] {
  return [
    ...markup.matchAll(
      /shell-sidebar-footer-row[\s\S]*?<span>([^<]*)<\/span>/g,
    ),
  ].map((match) => match[1] ?? "");
}

function footerRowLabelsFromDom(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".shell-sidebar-footer-row")].map(
    (row) => row.querySelector("span")?.textContent ?? "",
  );
}

async function flush(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountSidebar(
  path: string,
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
            path={path}
            user={user}
            onNavigate={onNavigate}
            onSignOut={noop}
          />
        </BenchProvider>
      </TestQueryProvider>,
    );
  });
  await flush(60);
  return { container, root };
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

  test("titles itself Agents and Channels and never renders a page-nav list", () => {
    const markup = renderSidebar("/settings/agents");
    // Section labels live inside the list (below its search box); the
    // panel keeps the accessible name for both groups.
    expect(markup).toContain('aria-label="Agents and Channels"');
    expect(markup).not.toContain('aria-label="Workbenches"');
    expect(markup).not.toContain(">Pages<");
    expect(markup).not.toContain("shell-rail-item");
  });

  test("first-run footer rail is Routines, Files, Skills, Agents, then the account row — no Plugins, Insights, Evals, or Inbox", () => {
    const markup = renderSidebar("/w");
    expect(footerRowLabelsFromMarkup(markup)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
    ]);
    expect(markup).toContain("data-ctx-account");
    expect(markup).not.toContain(">Inbox<");
    expect(markup).not.toContain('aria-label="Notifications"');
    // Settings is its own direct control beside the account row (one
    // click, not buried in the account menu).
    expect(markup).toContain('aria-label="Settings"');
    // Mission Control stays pinned above the rail — not a new footer
    // destination.
    expect(markup).toContain(">Mission Control<");
    expect(markup).toContain("shell-sidebar-mission-control");
    expect(markup.indexOf("shell-sidebar-mission-control")).toBeLessThan(
      markup.indexOf("shell-sidebar-footer-row"),
    );
  });

  test("first-run footer rail does not list Evals or Insights before there is honest usage", async () => {
    stubFetch({ usageTurns: 0, evalRuns: false });
    const { container, root } = await mountSidebar("/w");
    expect(footerRowLabelsFromDom(container)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
    ]);
    act(() => root.unmount());
    container.remove();
  });

  test("Plugins is not presented as a first-run tour destination", () => {
    const onPlugins = renderSidebar("/plugins");
    expect(footerRowLabelsFromMarkup(onPlugins)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
    ]);
    expect(onPlugins).not.toContain(">Plugins<");
    expect(onPlugins).not.toMatch(
      /shell-sidebar-footer-row"[^>]*aria-current="page"/,
    );
  });

  test("Evals, Insights, and Plugins remain reachable by URL and command palette", () => {
    const palettePaths = NAV_ROUTES.map((route) => route.path);
    const routedPaths = APP_ROUTES.map((route) => route.path);
    expect(palettePaths).toContain("/evals");
    expect(palettePaths).toContain("/insights");
    expect(palettePaths).toContain("/plugins");
    expect(routedPaths).toContain("/evals");
    expect(routedPaths).toContain("/insights");
    expect(routedPaths).toContain("/plugins");
  });

  test("marks the Routines row current for its own route only", () => {
    const onRoutines = renderSidebar("/routines");
    expect(onRoutines).toMatch(
      /shell-sidebar-footer-row"[^>]*data-active="true"[^>]*>[\s\S]*?>Routines</,
    );
    const elsewhere = renderSidebar("/w");
    expect(elsewhere).not.toMatch(/>Routines<[\s\S]{0,80}aria-current="page"/);
  });

  test("Insights joins the footer rail only when usage has turns", async () => {
    stubFetch({ usageTurns: 4, evalRuns: false });
    const { container, root } = await mountSidebar("/insights");
    expect(footerRowLabelsFromDom(container)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
      "Insights",
    ]);
    const insights = [
      ...container.querySelectorAll(".shell-sidebar-footer-row"),
    ].find((row) => row.textContent?.includes("Insights") === true);
    expect(insights?.getAttribute("aria-current")).toBe("page");
    act(() => root.unmount());
    container.remove();
  });

  test("Evals joins the footer rail only when eval runs exist", async () => {
    stubFetch({ usageTurns: 0, evalRuns: true });
    const { container, root } = await mountSidebar("/evals");
    expect(footerRowLabelsFromDom(container)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
      "Evals",
    ]);
    const evals = [
      ...container.querySelectorAll(".shell-sidebar-footer-row"),
    ].find((row) => row.textContent?.includes("Evals") === true);
    expect(evals?.getAttribute("aria-current")).toBe("page");
    act(() => root.unmount());
    container.remove();
  });

  test("a failed usage or evals probe omits the row rather than claiming usage", async () => {
    stubFetch({ failUsage: true, failEvals: true });
    const { container, root } = await mountSidebar("/w");
    expect(footerRowLabelsFromDom(container)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
    ]);
    act(() => root.unmount());
    container.remove();
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
          container.querySelector('[aria-label="Search agents and channels"]'),
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

  // Sidebar = opened DMs (Agents) + rooms (Channels). Visible agent
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

  test("renders one mixed recency list, interleaving a newer room above an older DM", async () => {
    const channel = {
      id: "ch_room",
      title: "Launch plan",
      kind: "workbench",
      pinned: false,
      participants: [],
      lastActivityAt: "2026-01-10T00:00:00.000Z",
    };
    const dm = {
      id: "ch_dm",
      title: "Myra",
      kind: "chat",
      pinned: false,
      participants: [],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    };
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals"))
        return Promise.resolve(json(membership));
      if (path.includes("/chat/workbenches?kind=workbench"))
        return Promise.resolve(json({ items: [channel] }));
      if (path.includes("/chat/workbenches?kind=chat"))
        return Promise.resolve(json({ items: [dm] }));
      if (path.includes("/approvals/needs-you"))
        return Promise.resolve(json({ items: [] }));
      if (path.includes("/top-level-runs"))
        return Promise.resolve(json({ data: [], nextCursor: null }));
      if (path.includes("/agent-definitions/visible"))
        return Promise.resolve(json({ definitions: [] }));
      return Promise.resolve(json({ items: [] }));
    }) as typeof fetch;

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
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.textContent?.includes("Launch plan")) break;
    }

    const agentsHeading = container.querySelector("#sidebar-agents-heading");
    const channelsHeading = container.querySelector(
      "#sidebar-channels-heading",
    );
    expect(agentsHeading).toBeNull();
    expect(channelsHeading).toBeNull();
    expect(container.querySelectorAll(".shell-panel-list-label")).toHaveLength(
      0,
    );
    const wraps = [...container.querySelectorAll(".shell-ch-row-wrap")];
    expect(wraps.map((row) => row.getAttribute("data-ctx-workbench"))).toEqual([
      "ch_room",
      "ch_dm",
    ]);
    expect(container.innerHTML.indexOf("Launch plan")).toBeLessThan(
      container.innerHTML.indexOf("Myra"),
    );
    expect(container.innerHTML).not.toContain("No workbenches yet");

    act(() => root.unmount());
    container.remove();
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
      if (container.innerHTML.includes(SIDEBAR_EMPTY_COPY)) break;
    }
    expect(container.innerHTML).toContain(SIDEBAR_EMPTY_COPY);
    expect(container.innerHTML).not.toContain("No agents yet");
    expect(container.innerHTML).not.toContain("No channels yet");
    expect(container.innerHTML).not.toContain("No workbenches yet");
    act(() => root.unmount());
    container.remove();
  });

  // Zero opened conversations: the mixed list speaks honestly — never a
  // fake New Workbench stub, and never the icon "No workbenches yet"
  // empty state. Create still lives on the + control (`/new`).
  test("zero workbenches: honest mixed-list empty copy, not a New Workbench stub", async () => {
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
      if (container.innerHTML.includes(SIDEBAR_EMPTY_COPY)) break;
    }
    expect(container.innerHTML).toContain(SIDEBAR_EMPTY_COPY);
    expect(container.querySelector(".shell-ch-row")).toBeNull();
    expect(container.innerHTML).not.toContain("New Workbench");
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
  // line, a feedback link out to the repo's GitHub issues, a divider, and
  // a danger-styled "Log out".
  //
  // A later pass split Settings out to its own direct icon beside the row
  // (one click instead of two) — the menu still carries everything else
  // that used to live alongside it, so nothing the old menu offered is
  // stranded.
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

    test("offers a Weekly usage line, a feedback link, and Log out", async () => {
      stubFetch();
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = await openAccountMenu(container);

      const menu = document.querySelector('[role="menu"]');
      expect(menu?.textContent).toContain("Weekly usage");
      expect(menu?.textContent).toContain("Send Feedback");
      expect(menu?.textContent).toContain("Log out");
      // Settings moved out to its own direct control (see the test
      // below) — the menu no longer duplicates it.
      expect(menu?.textContent).not.toContain("Settings");

      const feedbackLink = menu?.querySelector<HTMLAnchorElement>(
        'a[href*="github.com/corbitsdev/workbench"]',
      );
      expect(feedbackLink).not.toBeUndefined();
      expect(feedbackLink?.getAttribute("href")).toContain("/issues");
      expect(feedbackLink?.getAttribute("target")).toBe("_blank");

      act(() => root.unmount());
      container.remove();
    });

    // CL-6877: empty weekly usage is `$0.00`, never `$0.00 · 0 tok`.
    test("Weekly usage at zero spend shows $0.00 without 0 tok chrome", async () => {
      stubFetch({ usageTurns: 0 });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = await openAccountMenu(container);

      // Wait for the usage query to settle into the menu value.
      for (let i = 0; i < 20; i++) {
        const value = document.querySelector(
          ".shell-sidebar-account-menu-usage-value",
        );
        if (value?.textContent?.includes("$0.00") === true) break;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }

      const value = document.querySelector(
        ".shell-sidebar-account-menu-usage-value",
      );
      expect(value?.textContent).toContain("$0.00");
      expect(value?.textContent).not.toContain("0 tok");

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

  test("the settings icon navigates straight to Settings, no menu in the way", async () => {
    stubFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const navigated: string[] = [];
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

    const settingsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings"]',
    );
    expect(settingsButton).not.toBeNull();
    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toEqual(["/settings"]);
    // No popup menu opened along the way — this is a direct control, not
    // a trigger.
    expect(document.querySelector('[role="menu"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
