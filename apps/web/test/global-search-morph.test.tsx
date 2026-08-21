// CL-6410: the product's one search surface. DESIGN.md's Search section fixes
// how it is invoked from chrome: the top-nav magnifier morphs in place into an
// inline bar, Esc collapses it, and cmd+K reaches the identical palette —
// never a second search implementation.
//
// The motion assertions deliberately check the authored stylesheet and the
// tokens it consumes, not class names on the element: react-ui ships a
// prebuilt stylesheet, so a Tailwind motion utility (`duration-standard`,
// `ease-spring`) compiles to nothing here and a className assertion would
// green-light a morph that never runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
const reactUiCss = readFileSync(
  new URL("../node_modules/@corbits/react-ui/dist/styles.css", import.meta.url),
  "utf8",
);

/** The declaration block of the rule that names `className`. */
function ruleFor(css: string, className: string): string {
  const selector = new RegExp(`\\.${className}\\s*[,{]`);
  const block = css.split("}").find((candidate) => selector.test(candidate));
  if (block === undefined) throw new Error(`no rule for .${className}`);
  return block.slice(block.indexOf("{"));
}

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

/** A handle that is not a slug — minted before the rule tightened, or
 * imported. Its detail route cannot be guessed at. */
const unsluggedHandle = {
  ...slugHandled,
  id: "wfd_2",
  name: "Café Crème Bot",
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
      return Promise.resolve(
        json({ data: [slugHandled, unsluggedHandle], nextCursor: null }),
      );
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

function morphField(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="stage-search-field"]',
  );
}

function paletteInputs(): readonly HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[role="combobox"]')];
}

function paletteInput(): HTMLInputElement {
  const input = paletteInputs()[0];
  if (input === undefined) throw new Error("the palette rendered no input");
  return input;
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

async function pressEscapeInPalette(): Promise<void> {
  await act(async () => {
    paletteInput().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
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

function Harness({
  navigate = noop,
  path = "/agents",
}: {
  readonly navigate?: (to: string) => void;
  readonly path?: string;
}) {
  return (
    <TestQueryProvider>
      <ThemeProvider>
        <NavigationProvider navigate={navigate}>
          <BenchProvider>
            <CommandPaletteProvider path={path} navigate={navigate} />
            <StageTopBar crumbs={[{ label: "Agents" }]} />
          </BenchProvider>
        </NavigationProvider>
      </ThemeProvider>
    </TestQueryProvider>
  );
}

describe("the top-nav search morph", () => {
  test("the collapsed control is a magnifier and nothing else", async () => {
    await render(<Harness />);
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(morphField()).toBeNull();
  });

  test("clicking the magnifier morphs it in place into the inline bar", async () => {
    await render(<Harness />);
    await act(async () => {
      magnifier().click();
    });
    await settle();

    expect(morphField()).not.toBeNull();
    expect(magnifier().getAttribute("aria-expanded")).toBe("true");
    expect(searchShell().dataset.expanded).toBe("true");
  });

  test("the morph is a real transition: authored on the element, on tokens the shipped stylesheet defines", () => {
    const rule = ruleFor(appCss, "stage-search");
    // One element whose width animates — a swap between two boxes could not
    // transition at all.
    expect(rule).toContain("transition: width var(--duration-standard)");
    // react-ui's documented curve for something growing in place; a spring's
    // overshoot would jitter the whole top bar.
    expect(rule).toContain("var(--ease-in-out)");
    // Both tokens have to exist in the prebuilt sheet the app actually
    // imports, or the declaration silently resolves to nothing.
    expect(reactUiCss).toContain("--duration-standard:");
    expect(reactUiCss).toContain("--ease-in-out:");
  });

  test("the morph carries no Tailwind motion utility, which would be inert against the prebuilt stylesheet", async () => {
    await render(<Harness />);
    await act(async () => {
      magnifier().click();
    });
    expect(searchShell().className).not.toContain("duration-");
    expect(searchShell().className).not.toContain("ease-");
    expect(searchShell().className).not.toContain("transition-");
  });

  test("reduced motion needs no per-element handling: the shipped stylesheet collapses every transition", () => {
    const reducedMotionBlock = reactUiCss.slice(
      reactUiCss.lastIndexOf("prefers-reduced-motion: reduce"),
    );
    expect(reducedMotionBlock).toContain("transition-duration: 0.01ms");
  });

  test("the inline bar shows the query instead of impersonating an input", async () => {
    await render(<Harness />);
    await act(async () => {
      magnifier().click();
    });
    await settle();
    await typeInPalette("resea");

    const field = morphField();
    expect(field?.tagName).toBe("SPAN");
    expect(field?.textContent).toBe("resea");
    // The palette owns the one editable search field in the product.
    expect(paletteInputs()).toHaveLength(1);
  });
});

describe("collapsing back to the magnifier", () => {
  test("Escape inside the palette collapses the morph and returns focus to the magnifier", async () => {
    await render(<Harness />);
    await act(async () => {
      magnifier().click();
    });
    await settle();
    expect(morphField()).not.toBeNull();

    await pressEscapeInPalette();

    expect(morphField()).toBeNull();
    expect(magnifier().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(magnifier());
  });

  test("focus lands on the magnifier even when the palette was opened by cmd+K, which never focused it", async () => {
    await render(<Harness />);
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
    expect(document.activeElement).not.toBe(magnifier());

    await pressEscapeInPalette();

    expect(document.activeElement).toBe(magnifier());
  });

  test("a route change closes the surface, so Back never leaves it standing", async () => {
    await render(<Harness path="/agents" />);
    await act(async () => {
      magnifier().click();
    });
    await settle();
    expect(paletteInputs()).toHaveLength(1);

    await render(<Harness path="/agents/research-analyst" />);

    expect(paletteInputs()).toHaveLength(0);
    expect(morphField()).toBeNull();
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
    const fromShortcut = paletteInput().getAttribute("aria-label");
    expect(searchShell().dataset.expanded).toBe("true");

    await pressEscapeInPalette();
    expect(paletteInputs()).toHaveLength(0);

    await act(async () => {
      magnifier().click();
    });
    await settle();
    expect(paletteInputs()).toHaveLength(1);
    expect(paletteInput().getAttribute("aria-label")).toBe(fromShortcut);
  });

  test("selecting a result navigates to that entity's own slug detail route", async () => {
    const navigated: string[] = [];
    await render(<Harness navigate={(to) => navigated.push(to)} />);

    await act(async () => {
      magnifier().click();
    });
    await settle();
    await typeInPalette("@");

    await act(async () => {
      resultRow("research-analyst").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(navigated).toContain("/agents/research-analyst");
  });

  test("an entity whose handle is not a slug keeps its id deep link, never a guessed slug", async () => {
    const navigated: string[] = [];
    await render(<Harness navigate={(to) => navigated.push(to)} />);

    await act(async () => {
      magnifier().click();
    });
    await settle();
    await typeInPalette("@");

    await act(async () => {
      resultRow("Café Crème Bot").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(navigated).toContain("/agents/wfd_2");
    expect(navigated).not.toContain("/agents/cafe-creme-bot");
  });
});
