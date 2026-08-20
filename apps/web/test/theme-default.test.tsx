// Owner ruling: a brand-new user sees the Corbits LIGHT theme regardless of
// OS preference; only an explicit choice may switch to dark, and that choice
// still persists as before (see ThemeProvider's own storage contract).
// main.tsx wires this by passing `defaultMode="light"` — this test pins the
// app-composition contract so the default cannot regress back to "system".

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider, useTheme } from "@corbits/react-ui";

const STORAGE_KEY = "corbits-theme:fresh-user-test";

function setSystemPrefersDark(prefersDark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: prefersDark,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function Probe() {
  const { resolvedMode } = useTheme();
  return <span data-testid="resolved-mode">{resolvedMode}</span>;
}

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("app default theme", () => {
  test("fresh render with no stored preference and a dark OS still resolves light", async () => {
    setSystemPrefersDark(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ThemeProvider storageKey={STORAGE_KEY} defaultMode="light">
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="resolved-mode"]')?.textContent,
    ).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");

    root.unmount();
    container.remove();
  });
});
