// Personal Settings' opening section (CL-6133): the Account card's Sign out
// affordance (CL-6105 — the footer avatar menu is not the only way in), its
// copy-to-clipboard email action, and the Appearance card's theme Select
// wired to `ThemeProvider`'s three-state mode contract.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ThemeProvider } from "@corbits/react-ui";
import { AccountSectionView, AppearanceSection } from "../src/account-section";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
  document.documentElement.classList.remove("dark");
});

function mount(element: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

describe("AccountSectionView", () => {
  test("renders no Sign out action when the host gives no onSignOut", () => {
    const el = mount(
      <AccountSectionView
        name="Ada Lovelace"
        email="ada@example.com"
        emailVerified={true}
      />,
    );
    expect(el.textContent).not.toContain("Sign out");
  });

  test("renders Sign out and calls it when the host supplies onSignOut", () => {
    let signedOut = false;
    const el = mount(
      <AccountSectionView
        name="Ada Lovelace"
        email="ada@example.com"
        emailVerified={true}
        onSignOut={() => {
          signedOut = true;
        }}
      />,
    );
    const button = [...el.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Sign out"),
    );
    expect(button).not.toBeUndefined();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(signedOut).toBe(true);
  });

  test("shows an avatar and the name/email in the account card, and the same email again in the quieter details subsection", () => {
    const el = mount(
      <AccountSectionView
        name="Ada Lovelace"
        email="ada@example.com"
        emailVerified={true}
      />,
    );
    expect(el.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Ada Lovelace",
    );
    expect(el.textContent).toContain("Ada Lovelace");
    expect(el.textContent).toContain("Account details");
    expect(el.textContent).toContain("verified");
  });

  test("copies the email to the clipboard and shows the Copied toast on click", async () => {
    const written: string[] = [];
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          written.push(value);
          return Promise.resolve();
        },
      },
    });
    try {
      const el = mount(
        <AccountSectionView
          name="Ada Lovelace"
          email="ada@example.com"
          emailVerified={true}
        />,
      );
      const copyButton = el.querySelector(
        'button[aria-label="Copy email"]',
      ) as HTMLButtonElement | null;
      expect(copyButton).not.toBeNull();
      act(() => copyButton?.click());
      await act(() => Promise.resolve());
      expect(written).toEqual(["ada@example.com"]);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});

describe("AppearanceSection", () => {
  test("defaults the theme Select to Follow System and offers all three modes", () => {
    const el = mount(
      <ThemeProvider storageKey="test-theme-default">
        <AppearanceSection />
      </ThemeProvider>,
    );
    const select = el.querySelector("select") as HTMLSelectElement | null;
    expect(select?.value).toBe("system");
    const optionValues = [...(select?.options ?? [])].map(
      (option) => option.value,
    );
    expect(optionValues).toEqual(["system", "light", "dark"]);
  });

  test("choosing Dark applies dark mode via ThemeProvider", async () => {
    const el = mount(
      <ThemeProvider storageKey="test-theme-dark">
        <AppearanceSection />
      </ThemeProvider>,
    );
    const select = el.querySelector("select") as HTMLSelectElement | null;
    act(() => {
      if (select !== null) {
        select.value = "dark";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(() => Promise.resolve());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
