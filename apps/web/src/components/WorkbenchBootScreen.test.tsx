/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  WorkbenchBootScreen,
  WorkbenchLoadingScreen,
} from "./WorkbenchBootScreen";

afterEach(cleanup);

describe("WorkbenchBootScreen", () => {
  it("names its status region by the given message", () => {
    render(<WorkbenchBootScreen message="Updating Workbench" />);
    expect(
      screen.getByRole("status", { name: "Updating Workbench" }),
    ).toBeTruthy();
  });

  it("shows the message, brand, and build-time version", () => {
    render(<WorkbenchBootScreen message="Loading Workbench" />);
    expect(screen.getByText("Loading Workbench")).toBeTruthy();
    expect(screen.getByText("Corbits Workbench")).toBeTruthy();
    // test-setup injects "0.0.0-test" for __APP_VERSION__.
    expect(screen.getByText("v0.0.0-test")).toBeTruthy();
  });
});

describe("WorkbenchLoadingScreen", () => {
  it("renders the boot screen with the Loading Workbench message", () => {
    render(<WorkbenchLoadingScreen />);
    expect(
      screen.getByRole("status", { name: "Loading Workbench" }),
    ).toBeTruthy();
  });
});
