// CL-6096: the "run this workbench on its own sidecar" toggle inside the
// bench section's progressive-disclosure "Advanced" panel. Covers the
// pure view component only — fetch/save wiring lives in `BenchSection`
// and is exercised through the API client's own tests.
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchSectionView } from "../src/bench-section";

function mount(
  props: Partial<Parameters<typeof BenchSectionView>[0]> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BenchSectionView
        name="Launch planning"
        slug="launch-planning"
        dirty={false}
        saving={false}
        error={null}
        savedAt={null}
        onNameChange={() => undefined}
        onSave={() => undefined}
        onReset={() => undefined}
        {...props}
      />,
    );
  });
  return { container, root };
}

describe("BenchSectionView sidecar placement", () => {
  test("is off by default and named 'Run this workbench on its own sidecar'", () => {
    const { container, root } = mount();
    try {
      const toggle = document.body.querySelector('[role="switch"]');
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      expect(document.body.textContent).toContain(
        "Run this workbench on its own sidecar",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reflects sidecarPlacementEnabled when true", () => {
    const { container, root } = mount({ sidecarPlacementEnabled: true });
    try {
      const toggle = document.body.querySelector('[role="switch"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("clicking the switch calls onSidecarPlacementChange with the flipped value", () => {
    let lastValue: boolean | undefined;
    const { container, root } = mount({
      sidecarPlacementEnabled: false,
      onSidecarPlacementChange: (enabled) => {
        lastValue = enabled;
      },
    });
    try {
      const toggle = document.body.querySelector<HTMLButtonElement>(
        '[role="switch"]',
      );
      act(() => toggle?.click());
      expect(lastValue).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("shows the save error text when sidecarPlacementError is set", () => {
    const { container, root } = mount({
      sidecarPlacementError: "Couldn't save this setting. Try again.",
    });
    try {
      expect(document.body.textContent).toContain(
        "Couldn't save this setting. Try again.",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
