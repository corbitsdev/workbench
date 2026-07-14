/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { ArtifactDetailShell } from "./ArtifactDetailShell";

afterEach(cleanup);

describe("ArtifactDetailShell", () => {
  it("renders hero accent, main stage, and metadata rail", () => {
    render(
      React.createElement(ArtifactDetailShell, {
        accentClass: "bg-green",
        header: React.createElement("h1", null, "Title"),
        rail: React.createElement("span", null, "Meta"),
        children: React.createElement("article", null, "Body"),
      }),
    );
    const shell = screen.getByTestId("artifact-detail-shell");
    expect(shell).toBeDefined();
    expect(shell.className).toContain("bg-surface");
    expect(screen.getByTestId("artifact-detail-main").textContent).toContain(
      "Body",
    );
    expect(screen.getByTestId("artifact-detail-rail").textContent).toContain(
      "Meta",
    );
    expect(screen.getByTestId("artifact-detail-main").innerHTML).toContain(
      "max-w-none",
    );
  });
});
