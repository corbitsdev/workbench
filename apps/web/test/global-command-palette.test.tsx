// DECISIONS.md → Search: `Cmd+K` opens the global command palette — a
// separate surface from the stage top bar's per-page filter magnifier
// (`stage-search-filter.test.tsx`). It has to work from anywhere, including
// a route that renders no stage top bar of its own (an unmatched route),
// which is exactly what PR #246 broke: the palette used to live inside
// `StageSearch`, so no `StageTopBar` meant no palette. `CommandPaletteProvider`
// now renders the palette itself, mounted once above `AppShell`, independent
// of whatever the route renders.

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

function stubMatchMedia(): void {
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const slugHandled = {
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
      return Promise.resolve(json({ data: [slugHandled], nextCursor: null }));
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
  stubMatchMedia();
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

function paletteInputs(): readonly HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[role="combobox"]')];
}

function paletteInput(): HTMLInputElement {
  const input = paletteInputs()[0];
  if (input === undefined) throw new Error("the palette rendered no input");
  return input;
}

async function pressCmdK(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  });
  await settle();
}

async function typeInPalette(value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setValue === undefined) throw new Error("no native value setter");
  const input = paletteInput();
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function resultRow(text: string): HTMLElement {
  const row = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.includes(text));
  if (row === undefined) throw new Error(`no result row for ${text}`);
  return row;
}

/** `withStageTopBar={false}` stands in for an unmatched route: no
 * `StageTopBar`, no magnifier, nothing the old, palette-inside-the-magnifier
 * wiring needed to mount the overlay. */
function Harness({
  navigate = noop,
  path = "/agents",
  withStageTopBar = true,
}: {
  readonly navigate?: (to: string) => void;
  readonly path?: string;
  readonly withStageTopBar?: boolean;
}) {
  return (
    <TestQueryProvider>
      <ThemeProvider>
        <NavigationProvider navigate={navigate}>
          <BenchProvider>
            <CommandPaletteProvider path={path} navigate={navigate}>
              {withStageTopBar ? (
                <StageTopBar crumbs={[{ label: "Agents" }]} />
              ) : (
                <div>Page not found</div>
              )}
            </CommandPaletteProvider>
          </BenchProvider>
        </NavigationProvider>
      </ThemeProvider>
    </TestQueryProvider>
  );
}

describe("Cmd+K opens the global command palette", () => {
  test("from an ordinary route", async () => {
    await render(<Harness />);
    expect(paletteInputs()).toHaveLength(0);

    await pressCmdK();

    expect(paletteInputs()).toHaveLength(1);
  });

  test("from an unmatched route with no stage top bar of its own", async () => {
    await render(<Harness withStageTopBar={false} />);
    expect(container.textContent).toContain("Page not found");
    expect(paletteInputs()).toHaveLength(0);

    await pressCmdK();

    expect(paletteInputs()).toHaveLength(1);
  });

  test("the palette is not reachable by clicking anything in the stage top bar — there is no magnifier door into it", async () => {
    await render(<Harness />);
    const stageSearch = container.querySelector('[data-testid="stage-search"]');
    // Agents has nothing to filter, so it carries no magnifier at all.
    expect(stageSearch).toBeNull();
  });

  test("a route change closes the palette, so Back never leaves it standing", async () => {
    await render(<Harness path="/agents" />);
    await pressCmdK();
    expect(paletteInputs()).toHaveLength(1);

    await render(<Harness path="/agents/research-analyst" />);

    expect(paletteInputs()).toHaveLength(0);
  });

  test("selecting a result navigates to that entity's own slug detail route", async () => {
    const navigated: string[] = [];
    await render(<Harness navigate={(to) => navigated.push(to)} />);

    await pressCmdK();
    await typeInPalette("@");

    await act(async () => {
      resultRow("research-analyst").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(navigated).toContain("/agents/research-analyst");
  });
});
