/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

import { ToolNarrative } from "./ToolNarrative";
import type { ToolCall } from "./types";

afterEach(() => {
  cleanup();
});

const LONG_TITLE =
  'Creating Linear issue "Build cross-browser Page Lens extension with capture pipeline"';

describe("ToolNarrative tool-row affordances (CL-3639)", () => {
  it("gives a truncatable title a native tooltip via the title attribute", () => {
    render(
      <ToolNarrative
        toolCalls={[
          {
            id: "c1",
            name: "linear__create_issue",
            result: "{}",
            isError: false,
          },
        ]}
        formatSummary={() => LONG_TITLE}
      />,
    );
    const summary = screen.getByTestId("tool-row-summary");
    expect(summary.getAttribute("title")).toBe(LONG_TITLE);
    expect(summary.className).toContain("truncate");
  });

  it("surfaces the provider's actual error message grouped with the failed row", () => {
    render(
      <ToolNarrative
        toolCalls={[
          {
            id: "c1",
            name: "attio__create_note",
            result: "Attio API 422: note body exceeds 10000 chars",
            isError: true,
          },
        ]}
        formatSummary={() => "Creating Attio note"}
      />,
    );
    // The failed row keeps the error marker and shows the provider message inline.
    expect(screen.getByTestId("tool-marker-error")).toBeDefined();
    const inline = screen.getByTestId("tool-row-error");
    expect(inline.textContent).toContain(
      "Attio API 422: note body exceeds 10000 chars",
    );
    expect(inline.getAttribute("title")).toContain("Attio API 422");
  });

  it("renders a pending (running) row without an expand toggle", () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "exa__search", isError: false },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Searching the web"}
      />,
    );
    const button = screen.getByTestId("tool-row-summary").closest("button");
    expect(button?.getAttribute("aria-expanded")).toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("uses one row treatment for succeeded and failed states (same summary testid)", () => {
    render(
      <ToolNarrative
        toolCalls={[
          { id: "ok", name: "exa__search", result: "[]", isError: false },
          {
            id: "bad",
            name: "attio__create_note",
            result: "boom",
            isError: true,
          },
        ]}
        formatSummary={(c) => `call-${c.id}`}
      />,
    );
    expect(screen.getAllByTestId("tool-row-summary")).toHaveLength(2);
  });
});
