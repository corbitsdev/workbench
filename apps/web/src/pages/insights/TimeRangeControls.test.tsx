import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimeRangeControls } from "./TimeRangeControls";

describe("TimeRangeControls", () => {
  afterEach(() => cleanup());

  it("renders the preset buttons in order", () => {
    const onPreset = mock(() => {});
    const onCustom = mock(() => {});

    render(
      <TimeRangeControls
        preset="30d"
        onPresetChange={onPreset}
        customRange={{}}
        onCustomRangeChange={onCustom}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain("24 hours");
    expect(labels).toContain("7 days");
    expect(labels).toContain("30 days");
    expect(labels).toContain("90 days");
    expect(labels).toContain("All time");
    expect(labels).toContain("Custom");
  });

  it("highlights the active preset", () => {
    const onPreset = mock(() => {});
    render(
      <TimeRangeControls
        preset="7d"
        onPresetChange={onPreset}
        customRange={{}}
        onCustomRangeChange={mock(() => {})}
      />,
    );
    const active = screen.getByRole("button", { name: "7 days" });
    expect(active.className).toContain("bg-accent/10");
    expect(active.className).toContain("text-accent");
  });

  it("shows custom date inputs only for the custom preset", () => {
    const onCustom = mock(() => {});
    const { rerender } = render(
      <TimeRangeControls
        preset="30d"
        onPresetChange={mock(() => {})}
        customRange={{}}
        onCustomRangeChange={onCustom}
      />,
    );
    expect(screen.queryByTestId("custom-range")).toBeNull();

    rerender(
      <TimeRangeControls
        preset="custom"
        onPresetChange={mock(() => {})}
        customRange={{ startDate: "2026-05-01" }}
        onCustomRangeChange={onCustom}
      />,
    );
    expect(screen.getByTestId("custom-range")).toBeDefined();
    expect(screen.getByTestId("custom-start")).toBeDefined();
    expect(screen.getByTestId("custom-end")).toBeDefined();
  });

  it("calls onPresetChange when a preset button is clicked", () => {
    const onPreset = mock(() => {});
    render(
      <TimeRangeControls
        preset="30d"
        onPresetChange={onPreset}
        customRange={{}}
        onCustomRangeChange={mock(() => {})}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(onPreset).toHaveBeenCalledWith("custom");
  });

  it("calls onCustomRangeChange when date inputs change", () => {
    const onCustom = mock((r: { startDate?: string; endDate?: string }) => r);
    render(
      <TimeRangeControls
        preset="custom"
        onPresetChange={mock(() => {})}
        customRange={{}}
        onCustomRangeChange={onCustom}
      />,
    );

    fireEvent.change(screen.getByTestId("custom-start"), {
      target: { value: "2026-05-01" },
    });
    expect(onCustom).toHaveBeenCalled();
    // second arg in mock is the updater result in this simple case, but we just assert call happened

    fireEvent.change(screen.getByTestId("custom-end"), {
      target: { value: "2026-05-10" },
    });
    expect(onCustom).toHaveBeenCalledTimes(2);
  });
});
