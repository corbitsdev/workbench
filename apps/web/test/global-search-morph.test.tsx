// CL-6410: the product's one search surface. DESIGN.md's Search section fixes
// how it is invoked from chrome: the top-nav magnifier morphs in place into an
// inline bar over ~200ms with the spring easing, Esc collapses it, and cmd+K
// reaches the identical palette — never a second search implementation. This
// suite covers the morph's open/close behaviour, both doors landing on one
// surface, a result navigating to a slug-addressed detail route, and the
// reduced-motion path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@corbits/react-ui";

import { BenchProvider } from "../src/bench-context";
import { CommandPaletteProvider } from "../src/command-palette-provider";
import { setCommandPaletteOpen } from "../src/command-palette-open-store";
import { NavigationProvider } from "../src/navigation";
import { StageTopBar } from "../src/shell/stage-top-bar";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

const TENANT = "tnt_1";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const definition = {
  id: "wfd_1",
  tenantId: TENANT,
  name: "research-analyst",
  description: "Answers research questions",
  currentVersion: "1",
  status: "deployed" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function stubShellFetch(): void {
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
    if (path.includes("/workflows/definitions"))
      return Promise.resolve(json({ data: [definition], nextCursor: null }));
    if (path.includes("/mcp-servers"))
      return Promise.resolve(json({ data: [] }));
    if (path.includes("/skills")) return Promise.resolve(json({ skills: [] }));
    if (path.includes("/routines")) return Promise.resolve(json({ data: [] }));
    return Promise.resolve(json({ data: [], nextCursor: null }));
  }) as typeof fetch;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia({});
  stubShellFetch();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCommandPaletteOpen(false);
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

function searchShell(): HTMLElement {
  const shell = container.querySelector<HTMLElement>(
    '[data-testid="stage-search"]',
  );
  if (shell === null) throw new Error("the top nav renders no search control");
  return shell;
}

function magnifier(): HTMLButtonElement {
  const button = searchShell().querySelector<HTMLButtonElement>(
    'button[aria-label="Search"]',
  );
  if (button === null) throw new Error("no magnifier in the top nav");
  return button;
}

function morphField(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    '[data-testid="stage-search-input"]',
  );
}

function paletteInputs(): readonly HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[role="combobox"]')];
}

function TopBarOnly() {
  return (
    <NavigationProvider navigate={noop}>
      <StageTopBar crumbs={[{ label: "Agents" }]} />
    </NavigationProvider>
  );
}

function Harness({
  navigate = noop,
}: {
  readonly navigate?: (to: string) => void;
}) {
  return (
    <TestQueryProvider>
      <ThemeProvider>
        <NavigationProvider navigate={navigate}>
          <BenchProvider>
            <CommandPaletteProvider path="/agents" navigate={navigate} />
            <StageTopBar crumbs={[{ label: "Agents" }]} />
          </BenchProvider>
        </NavigationProvider>
      </ThemeProvider>
    </TestQueryProvider>
  );
}

describe("the top-nav search morph", () => {
  test("the collapsed control is a magnifier and nothing else", async () => {
    await render(<TopBarOnly />);
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(morphField()).toBeNull();
  });

  test("clicking the magnifier morphs it in place into an inline input", async () => {
    await render(<TopBarOnly />);
    await act(async () => {
      magnifier().click();
    });

    expect(morphField()).not.toBeNull();
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");
    const shell = searchShell();
    expect(shell.dataset.expanded).toBe("true");
    // The morph is the shell's own width transition, on react-ui's motion
    // tokens — 200ms, spring easing.
    expect(shell.className).toContain("duration-standard");
    expect(shell.className).toContain("ease-spring");
  });

  test("Escape collapses the input back to the magnifier", async () => {
    await render(<TopBarOnly />);
    await act(async () => {
      magnifier().click();
    });
    expect(morphField()).not.toBeNull();

    await act(async () => {
      searchShell().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(morphField()).toBeNull();
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
  });

  test("under prefers-reduced-motion the swap is instant, with no transition", async () => {
    stubMatchMedia({ [REDUCED_MOTION]: true });
    await render(<TopBarOnly />);
    await act(async () => {
      magnifier().click();
    });

    const shell = searchShell();
    expect(morphField()).not.toBeNull();
    expect(shell.dataset.motion).toBe("instant");
    expect(shell.className).not.toContain("duration-standard");
    expect(shell.className).not.toContain("ease-spring");
  });
});

describe("one search surface, two doors", () => {
  test("cmd+K and the magnifier open the identical palette", async () => {
    await render(<Harness />);
    expect(paletteInputs()).toHaveLength(0);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await settle();
    expect(paletteInputs()).toHaveLength(1);
    const fromShortcut = paletteInputs()[0];
    expect(searchShell().dataset.expanded).toBe("true");

    await act(async () => {
      setCommandPaletteOpen(false);
    });
    await settle();
    expect(paletteInputs()).toHaveLength(0);

    await act(async () => {
      magnifier().click();
    });
    await settle();
    const fromClick = paletteInputs();
    expect(fromClick).toHaveLength(1);
    expect(fromClick[0]?.getAttribute("aria-label")).toBe(
      fromShortcut?.getAttribute("aria-label"),
    );
  });

  test("selecting a result navigates to that entity's slug detail route", async () => {
    const navigated: string[] = [];
    await render(<Harness navigate={(to) => navigated.push(to)} />);

    await act(async () => {
      magnifier().click();
    });
    await settle();

    const input = paletteInputs()[0];
    if (input === undefined) throw new Error("the palette rendered no input");
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setValue === undefined) throw new Error("no native value setter");
    await act(async () => {
      setValue.call(input, "@");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const result = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent?.includes("research-analyst"));
    if (result === undefined) throw new Error("the agent never showed up");
    await act(async () => {
      result.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigated).toContain("/agents/research-analyst");
  });
});
