/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ReconnectingOverlay } from "./ReconnectingOverlay";

afterEach(cleanup);

describe("ReconnectingOverlay", () => {
  it("announces itself as a live status region named by its message", () => {
    render(<ReconnectingOverlay />);
    expect(
      screen.getByRole("status", { name: "Updating Workbench" }),
    ).toBeTruthy();
  });

  it("shows the update statement and brand", () => {
    render(<ReconnectingOverlay />);
    expect(screen.getByText("Updating Workbench")).toBeTruthy();
    expect(screen.getByText("Corbits Workbench")).toBeTruthy();
  });

  it("renders the build-time app version", () => {
    render(<ReconnectingOverlay />);
    // test-setup injects "0.0.0-test" for __APP_VERSION__.
    expect(screen.getByText("v0.0.0-test")).toBeTruthy();
  });
});
