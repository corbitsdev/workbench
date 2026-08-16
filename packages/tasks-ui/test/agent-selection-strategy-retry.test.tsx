// CL-6105: the manual agent-selection strategy moved off a hand-rolled
// retry-less list state onto `@corbits/api-query`'s `APIQuery` +
// `QueryView` — a failed agent list load now offers the shared Retry
// affordance and an unauthenticated failure renders as sign-in-required
// rather than the generic error copy.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { UnauthenticatedError } from "@corbits/api-query";
import type { TaskAgentOption } from "../src/agent-selection-strategy";
import { createManualAgentSelectionStrategy } from "../src/agent-selection-strategy";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

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

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const agents: readonly TaskAgentOption[] = [{ id: "wfd_1", name: "bot" }];

describe("createManualAgentSelectionStrategy retry", () => {
  test("a failed load shows Retry, and clicking it recovers", async () => {
    let calls = 0;
    const Strategy = createManualAgentSelectionStrategy(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return agents;
    });

    const el = mount(
      createElement(Strategy, {
        tenantId: "tnt_1",
        selectedId: null,
        onSelect: () => undefined,
        onOptionsResolved: () => undefined,
      }),
    );
    await settle();

    const retryButton = [...el.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Retry",
    );
    expect(retryButton).not.toBeUndefined();

    act(() => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(calls).toBe(2);
    expect(el.textContent).toContain("bot");
  });

  test("an UnauthenticatedError renders sign-in-required", async () => {
    const Strategy = createManualAgentSelectionStrategy(async () => {
      throw new UnauthenticatedError();
    });

    const el = mount(
      createElement(Strategy, {
        tenantId: "tnt_1",
        selectedId: null,
        onSelect: () => undefined,
        onOptionsResolved: () => undefined,
      }),
    );
    await settle();

    expect(el.textContent).toContain("Sign in required");
  });
});
