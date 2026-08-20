// CL-6360 regression: the onboarding failure path must render the
// consumer-language card — never the raw error text (freshness-gate
// prose, file paths, stack detail) a hub route's exception happened to
// carry. `ProvisioningErrorPage` is what `App` renders for a signed-in
// session whose first-login provisioning failed (see `app.tsx`); this
// pins its rendered output to exactly the consumer message and refId the
// caller hands it, nothing else.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ProvisioningErrorPage } from "../src/pages/provisioning-error-page";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function renderPage(props: {
  message: string;
  refId?: string;
  onRetry: () => void;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ProvisioningErrorPage {...props} />));
  return container;
}

describe("ProvisioningErrorPage", () => {
  test("renders the consumer-language card, not a raw error string", () => {
    const el = renderPage({
      message:
        "Setting up your workbench hit a snag — we're on it. Try again in a moment.",
      refId: "1a2b3c-9z",
      onRetry: () => undefined,
    });

    expect(el.textContent).toContain("Couldn't set up your workbench");
    expect(el.textContent).toContain("Setting up your workbench hit a snag");
    expect(el.textContent).toContain("Reference: 1a2b3c-9z");
    // Never a file path or stack-shaped string from an underlying failure.
    expect(el.textContent).not.toContain("/Users/");
    expect(el.textContent).not.toContain(".ts:");
    expect(el.textContent).not.toContain("StaleToolPackageError");
  });

  test("omits the reference line entirely when no refId is given", () => {
    const el = renderPage({
      message: "Something went wrong.",
      onRetry: () => undefined,
    });

    expect(el.textContent).not.toContain("Reference:");
  });

  test("the retry action calls back", () => {
    let retried = false;
    const el = renderPage({
      message: "Something went wrong.",
      onRetry: () => {
        retried = true;
      },
    });

    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    act(() =>
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(retried).toBe(true);
  });
});
