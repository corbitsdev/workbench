/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { ActivityBlock } from "./ActivityBlock";
import type { ToolCall } from "./types";

afterEach(() => {
  cleanup();
});

const tool = (extra?: Partial<ToolCall>): ToolCall => ({
  id: "c1",
  name: "attio__query_records",
  result: "[]",
  isError: false,
  ...extra,
});

describe("ActivityBlock", () => {
  it("is collapsed by default and hides the trace until expanded", () => {
    render(
      <ActivityBlock
        reasoning="Weighing the options"
        toolCalls={[tool()]}
        streaming={false}
        messageKey="m1"
        formatSummary={() => "Searching Attio"}
      />,
    );
    expect(screen.queryByTestId("activity-detail")).toBeNull();
    expect(screen.queryByText("Weighing the options")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    const detail = screen.getByTestId("activity-detail");
    expect(detail.textContent).toContain("Weighing the options");
    expect(detail.textContent).toContain("Searching Attio");
  });

  it("renders identically (same collapsed structure) whether streaming or settled", () => {
    const props = {
      reasoning: "Weighing the options",
      toolCalls: [tool()],
      messageKey: "m1",
      formatSummary: () => "Searching Attio",
    };
    const settled = render(
      <ActivityBlock {...props} streaming={false} />,
    );
    const settledBlock = settled.getByTestId("activity-block").outerHTML;
    cleanup();
    const streaming = render(<ActivityBlock {...props} streaming={true} />);
    // Both expose the single collapsible block with the toggle + summary.
    expect(streaming.getByTestId("activity-block")).toBeDefined();
    expect(settledBlock).toContain("activity-summary");
    expect(
      streaming.getByRole("button", { name: "Show activity" }),
    ).toBeDefined();
  });

  it("shows a rolling reasoning label while streaming", () => {
    render(
      <ActivityBlock
        reasoning={"First I check the CRM\nNow drafting the reply"}
        toolCalls={[]}
        streaming
        messageKey="m1"
      />,
    );
    expect(screen.getByTestId("activity-summary").textContent).toBe(
      "Now drafting the reply",
    );
  });

  it("rolls settled tools into the summary with a tool count", () => {
    render(
      <ActivityBlock
        reasoning=""
        toolCalls={[tool({ id: "c1" }), tool({ id: "c2" })]}
        streaming={false}
        messageKey="m1"
        summarizeCalls={() => "Checked Attio twice"}
      />,
    );
    expect(screen.getByTestId("activity-summary").textContent).toBe(
      "Checked Attio twice",
    );
    expect(screen.getByTestId("activity-count").textContent).toContain(
      "2 tools",
    );
  });

  it("marks the summary as an error when a tool failed", () => {
    render(
      <ActivityBlock
        reasoning=""
        toolCalls={[tool({ isError: true, result: "boom" })]}
        streaming={false}
        messageKey="m1"
        summarizeCalls={() => "Attio call failed"}
      />,
    );
    expect(screen.getByTestId("activity-summary").className).toContain(
      "text-red",
    );
  });

  it("persists expand state through the host hooks", () => {
    const prefs = new Map<string, boolean>();
    render(
      <ActivityBlock
        reasoning="Thinking"
        toolCalls={[]}
        streaming={false}
        messageKey="k1"
        isExpanded={(k) => prefs.get(k) === true}
        setExpanded={(k, v) => {
          if (v) prefs.set(k, true);
          else prefs.delete(k);
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    expect(prefs.get("k1")).toBe(true);
  });
});
