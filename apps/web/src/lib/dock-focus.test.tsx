import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { requestDockFocus, useDockFocus } from "./dock-focus";

function Harness() {
  const focus = useDockFocus();
  return (
    <div data-testid="focus">
      {focus ? `${focus.runId}:${focus.nonce}` : "none"}
    </div>
  );
}

afterEach(cleanup);

describe("dock focus store", () => {
  it("publishes the requested run and bumps the nonce so repeat clicks on the same run re-fire", () => {
    render(<Harness />);

    act(() => requestDockFocus("run-1"));
    const first = screen.getByTestId("focus").textContent ?? "";
    expect(first.startsWith("run-1:")).toBe(true);
    const firstNonce = Number(first.split(":")[1]);

    // A second click on the SAME run must change the published value so the
    // host effect re-runs and re-pulses the dock.
    act(() => requestDockFocus("run-1"));
    const second = screen.getByTestId("focus").textContent ?? "";
    const secondNonce = Number(second.split(":")[1]);
    expect(secondNonce).toBeGreaterThan(firstNonce);

    act(() => requestDockFocus("run-2"));
    expect(screen.getByTestId("focus").textContent?.startsWith("run-2:")).toBe(
      true,
    );
  });
});
