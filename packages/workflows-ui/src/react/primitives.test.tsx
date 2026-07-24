/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { FilterChip, ScopePill, StatusChip } from "./primitives";
import { livePhaseLabel, livePhaseToTone } from "./LiveRunInspector";

afterEach(() => {
  cleanup();
});

describe("StatusChip", () => {
  test("renders label and tone", () => {
    render(<StatusChip tone="awaiting" label="Needs you" />);
    expect(screen.getByText("Needs you")).toBeTruthy();
  });
});

describe("ScopePill", () => {
  test("defaults Mine / Everyone labels", () => {
    const { rerender } = render(<ScopePill scope="personal" />);
    expect(screen.getByText("Mine")).toBeTruthy();
    rerender(<ScopePill scope="tenant" />);
    expect(screen.getByText("Everyone")).toBeTruthy();
  });
});

describe("FilterChip", () => {
  test("shows optional count", () => {
    render(
      <FilterChip selected count={3}>
        All
      </FilterChip>,
    );
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });
});

describe("livePhase helpers", () => {
  test("maps phase to tone and label", () => {
    expect(livePhaseToTone("awaiting")).toBe("awaiting");
    expect(livePhaseLabel("awaiting")).toBe("Needs you");
    expect(livePhaseToTone("completed")).toBe("done");
    expect(livePhaseLabel("running")).toBe("Running");
  });
});
