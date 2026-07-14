/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import React from "react";
import { ReasoningDisclosure } from "./ReasoningDisclosure";

afterEach(() => {
  cleanup();
});

describe("ReasoningDisclosure", () => {
  it("renders collapsed by default while streaming", () => {
    render(
      <ReasoningDisclosure
        reasoning="Still thinking"
        streaming
        messageKey="k1"
      />,
    );
    expect(screen.queryByText("Still thinking")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand reasoning" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
  });

  it("calls setReasoningExpanded when toggled", () => {
    const prefs = new Map<string, boolean>();
    render(
      <ReasoningDisclosure
        reasoning="Detail"
        streaming={false}
        messageKey="k1"
        isReasoningExpanded={(key) => prefs.get(key) === true}
        setReasoningExpanded={(key, expanded) => {
          if (expanded) prefs.set(key, true);
          else prefs.delete(key);
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand reasoning" }));
    expect(prefs.get("k1")).toBe(true);
    expect(screen.getByText("Detail")).toBeDefined();
  });

  it("reads persisted expanded state on mount", () => {
    render(
      <ReasoningDisclosure
        reasoning="Saved"
        streaming={false}
        messageKey="k2"
        isReasoningExpanded={() => true}
        setReasoningExpanded={() => undefined}
      />,
    );
    expect(screen.getByText("Saved")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Collapse reasoning" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });
});