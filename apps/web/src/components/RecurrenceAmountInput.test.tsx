/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecurrenceAmountInput } from "./RecurrenceAmountInput";

afterEach(() => {
  cleanup();
});

describe("RecurrenceAmountInput", () => {
  it("commits a valid whole-number edit", () => {
    const onCommit = mock(() => undefined);
    render(
      <RecurrenceAmountInput
        amount={1}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "5" },
    });
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it("does not commit while the field is cleared, but keeps showing the empty text and a validation message (CL-4278 review fix #2)", () => {
    const onCommit = mock(() => undefined);
    render(
      <RecurrenceAmountInput
        amount={5}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("does not commit 0 or a negative amount", () => {
    const onCommit = mock(() => undefined);
    render(
      <RecurrenceAmountInput
        amount={5}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.change(input, { target: { value: "-1" } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit a fractional amount (CL-4278 review fix #3)", () => {
    const onCommit = mock(() => undefined);
    render(
      <RecurrenceAmountInput
        amount={1}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(input.getAttribute("step")).toBe("1");
    expect(input.getAttribute("min")).toBe("1");
  });

  it("reverts an invalid draft to the last committed amount on blur", () => {
    const onCommit = mock(() => undefined);
    render(
      <RecurrenceAmountInput
        amount={5}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.blur(input);
    expect(input.value).toBe("5");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resyncs the draft when the committed amount changes from elsewhere (e.g. a unit switch)", () => {
    const onCommit = mock(() => undefined);
    const { rerender } = render(
      <RecurrenceAmountInput
        amount={1}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    rerender(
      <RecurrenceAmountInput
        amount={3}
        ariaLabel="Amount"
        className="x"
        onCommit={onCommit}
      />,
    );
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "3",
    );
  });
});
