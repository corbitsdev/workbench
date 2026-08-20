import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { Chip, type ChipTone } from "./chip";

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

function render(tone: ChipTone, label: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Chip tone={tone}>{label}</Chip>);
  });
  return container;
}

describe("Chip", () => {
  test.each<ChipTone>(["working", "ok", "needs-you"])(
    "renders %s tone as a data-tone attribute on .chip",
    (tone) => {
      const el = render(tone, "Reviewing");
      const chip = el.querySelector(".chip");
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute("data-tone")).toBe(tone);
      expect(chip?.textContent).toBe("Reviewing");
    },
  );
});
