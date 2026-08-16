// The Account section's Sign out affordance (CL-6105): the footer avatar
// menu is not the only way in — a person already on this settings screen
// should find the same action here, so it renders whenever a host supplies
// `onSignOut`, and stays absent for a host (or test) that renders the
// section standalone with no sign-out concept of its own.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { AccountSectionView } from "../src/account-section";

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
});
