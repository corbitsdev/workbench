/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAttachShortcut } from "./use-attach-shortcut";

function Harness({ onAttach }: { onAttach: () => boolean }) {
  useAttachShortcut(onAttach);
  return (
    <div>
      <input data-testid="field" />
    </div>
  );
}

afterEach(cleanup);

describe("useAttachShortcut", () => {
  it("fires on Cmd+I and prevents default when something attached", () => {
    const onAttach = mock(() => true);
    render(<Harness onAttach={onAttach} />);

    const event = new KeyboardEvent("keydown", {
      key: "i",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(event);

    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not prevent default when nothing was attached", () => {
    const onAttach = mock(() => false);
    render(<Harness onAttach={onAttach} />);

    const event = new KeyboardEvent("keydown", {
      key: "i",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(event);

    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("is inert while focus is inside a text field", () => {
    const onAttach = mock(() => true);
    render(<Harness onAttach={onAttach} />);
    const field = screen.getByTestId("field");

    fireEvent.keyDown(field, { key: "i", metaKey: true });

    expect(onAttach).not.toHaveBeenCalled();
  });

  it("ignores a bare 'i' and chorded variants", () => {
    const onAttach = mock(() => true);
    render(<Harness onAttach={onAttach} />);

    fireEvent.keyDown(document, { key: "i" });
    fireEvent.keyDown(document, { key: "i", metaKey: true, shiftKey: true });

    expect(onAttach).not.toHaveBeenCalled();
  });
});
