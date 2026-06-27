import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ViewToggle } from "./ViewToggle";

afterEach(cleanup);

describe("ViewToggle", () => {
  it("marks the active mode as pressed", () => {
    render(<ViewToggle mode="rows" onChange={() => {}} />);
    expect(
      screen.getByLabelText("Rows view").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByLabelText("Grid view").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("emits the chosen mode on click", () => {
    const onChange = mock((_m: "grid" | "rows") => {});
    render(<ViewToggle mode="grid" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Rows view"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe("rows");
  });
});
