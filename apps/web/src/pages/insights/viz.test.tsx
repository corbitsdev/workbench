/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { DeltaBadge, Heatmap, MiniBars, Sparkline, TokenMosaic } from "./viz";
import { computeDelta } from "./metrics";

afterEach(() => cleanup());

describe("Sparkline", () => {
  it("renders one polyline spanning every point in the series", () => {
    render(<Sparkline values={[1, 5, 3, 9]} label="turns" />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.getAttribute("data-point-count")).toBe("4");
    const poly = svg.querySelector("polyline");
    expect(poly).not.toBeNull();
    expect(poly?.getAttribute("points")?.split(" ")).toHaveLength(4);
  });

  it("shows an empty state instead of an svg when there is no data", () => {
    render(<Sparkline values={[]} label="turns" />);
    screen.getByTestId("sparkline-empty");
    expect(screen.queryByTestId("sparkline")).toBeNull();
  });
});

describe("Heatmap", () => {
  it("renders one cell per day carrying its date and value", () => {
    render(
      <Heatmap
        label="activity"
        days={[
          { date: "2026-06-01", value: 0 },
          { date: "2026-06-02", value: 8 },
        ]}
      />,
    );
    const cells = screen.getAllByTestId("heatmap-cell");
    expect(cells).toHaveLength(2);
    expect(cells[1].getAttribute("data-date")).toBe("2026-06-02");
    expect(cells[1].getAttribute("data-value")).toBe("8");
  });

  it("renders the busiest day more opaque than an empty day", () => {
    render(
      <Heatmap
        label="activity"
        days={[
          { date: "a", value: 0 },
          { date: "b", value: 10 },
        ]}
      />,
    );
    const [empty, busy] = screen.getAllByTestId("heatmap-cell");
    const op = (el: Element) =>
      Number((el as HTMLElement).style.opacity || "0");
    expect(op(busy)).toBeGreaterThan(op(empty));
  });
});

describe("TokenMosaic", () => {
  it("sizes each segment rect to its share of the total", () => {
    render(
      <TokenMosaic
        label="tokens"
        parts={[
          { label: "in", value: 75 },
          { label: "out", value: 25 },
        ]}
      />,
    );
    const rects = screen.getAllByTestId("mosaic-rect");
    expect(rects[0].getAttribute("width")).toBe("75");
    expect(rects[1].getAttribute("width")).toBe("25");
  });
});

describe("DeltaBadge", () => {
  it("renders an up arrow and percentage for growth", () => {
    render(<DeltaBadge delta={computeDelta(150, 100)} />);
    const badge = screen.getByTestId("delta-badge");
    expect(badge.getAttribute("data-direction")).toBe("up");
    expect(badge.textContent).toContain("50%");
    expect(badge.textContent).toContain("▲");
  });

  it("falls back to an absolute delta when percentage is undefined", () => {
    render(<DeltaBadge delta={computeDelta(10, 0)} />);
    const badge = screen.getByTestId("delta-badge");
    expect(badge.getAttribute("data-direction")).toBe("up");
    expect(badge.textContent).toContain("10");
  });

  it("renders nothing when there is no previous window to compare", () => {
    render(<DeltaBadge delta={computeDelta(10, null)} />);
    expect(screen.queryByTestId("delta-badge")).toBeNull();
  });
});

describe("MiniBars", () => {
  it("scales the longest bar to full width", () => {
    render(
      <MiniBars
        label="models"
        rows={[
          { label: "deepseek-v4-flash", value: 100 },
          { label: "kimi", value: 50 },
        ]}
      />,
    );
    const fills = screen.getAllByTestId("mini-bar-fill");
    expect((fills[0] as HTMLElement).style.width).toBe("100%");
    expect((fills[1] as HTMLElement).style.width).toBe("50%");
  });
});
