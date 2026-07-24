/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { KindPickerCard } from "./KindPicker";
import type { KindPickerItem } from "./types";

afterEach(() => {
  cleanup();
});

const baseItem: KindPickerItem = {
  id: "call-brief",
  label: "Call Brief",
  description: "Turn a call into a brief.",
};

describe("KindPickerCard", () => {
  test("renders no category label node when the item has none", () => {
    render(<KindPickerCard item={baseItem} />);
    expect(screen.getByText("Call Brief")).toBeTruthy();
    expect(screen.queryByTestId("kind-picker-category-label")).toBeNull();
  });

  test("renders the category label node with its text when the item provides one", () => {
    render(
      <KindPickerCard
        item={{ ...baseItem, category: "research", categoryLabel: "Research" }}
      />,
    );
    expect(screen.getByTestId("kind-picker-category-label").textContent).toBe(
      "Research",
    );
  });
});
