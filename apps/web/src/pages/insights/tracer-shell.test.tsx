/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CopyId } from "./tracer-shell";

afterEach(() => {
  cleanup();
});

describe("CopyId", () => {
  it("writes the id to the clipboard and shows a confirmation state", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CopyId id="run_abc123" />);
    const button = screen.getByRole("button", { name: "Copy ID" });

    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("run_abc123");
    });
    await waitFor(() => {
      expect(button.querySelector("svg.text-green")).not.toBeNull();
    });
  });

  it("does not enter the confirmation state when the clipboard write fails", async () => {
    const writeText = mock(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CopyId id="run_fail" />);
    const button = screen.getByRole("button", { name: "Copy ID" });

    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("run_fail");
    });
    expect(button.querySelector("svg.text-green")).toBeNull();
  });
});
