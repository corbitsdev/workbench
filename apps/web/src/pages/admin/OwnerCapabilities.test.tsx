/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
}));

import { OwnerCapabilities } from "./OwnerCapabilities";

afterEach(() => cleanup());

describe("OwnerCapabilities", () => {
  it("lists integrations, each linking to its own sub-page", () => {
    render(<OwnerCapabilities />);
    expect(screen.getByText("Gamma"));
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Gamma"),
    );
    expect(link?.getAttribute("href")).toBe("/owner/capabilities/gamma");
  });
});
