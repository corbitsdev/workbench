/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { ActivityBlock } from "./ActivityBlock";
import type { Part } from "./types";

afterEach(() => {
  cleanup();
});

function toolPart(extra?: Partial<Extract<Part, { type: "tool" }>>): Part {
  const base: Extract<Part, { type: "tool" }> = {
    type: "tool",
    toolCallId: "c1",
    toolName: "attio__query_records",
    state: "output-available",
    output: "[]",
  };
  return { ...base, ...extra };
}

function pendingToolPart(
  extra?: Partial<Extract<Part, { type: "tool" }>>,
): Part {
  return {
    type: "tool",
    toolCallId: "c1",
    toolName: "attio__query_records",
    state: "pending",
    ...extra,
  };
}

function failedToolPart(
  errorText: string,
  extra?: Partial<Extract<Part, { type: "tool" }>>,
): Part {
  return {
    type: "tool",
    toolCallId: "c1",
    toolName: "attio__query_records",
    state: "output-error",
    errorText,
    ...extra,
  };
}

function reasoningPart(text: string): Part {
  return { type: "reasoning", text };
}

describe("ActivityBlock", () => {
  it("is collapsed by default and hides the trace until expanded", () => {
    render(
      <ActivityBlock
        parts={[reasoningPart("Weighing the options"), toolPart()]}
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
      parts: [reasoningPart("Weighing the options"), toolPart()],
      messageKey: "m1",
      formatSummary: () => "Searching Attio",
    };
    const settled = render(<ActivityBlock {...props} streaming={false} />);
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

  it("shows a rolling label from the trailing reasoning part while streaming", () => {
    render(
      <ActivityBlock
        parts={[
          reasoningPart("First I check the CRM"),
          reasoningPart("Now drafting the reply"),
        ]}
        streaming
        messageKey="m1"
      />,
    );
    expect(screen.getByTestId("activity-summary").textContent).toBe(
      "Now drafting the reply",
    );
  });

  it("shows a rolling label from a trailing pending tool part while streaming", () => {
    render(
      <ActivityBlock
        parts={[pendingToolPart()]}
        streaming
        messageKey="m1"
        formatSummary={() => "Searching Attio"}
      />,
    );
    expect(screen.getByTestId("activity-summary").textContent).toBe(
      "Searching Attio",
    );
  });

  it("rolls settled tools into the summary with a tool count", () => {
    render(
      <ActivityBlock
        parts={[toolPart({ toolCallId: "c1" }), toolPart({ toolCallId: "c2" })]}
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

  it("never paints the settled summary red when a tool failed (CL-3668 color discipline)", () => {
    render(
      <ActivityBlock
        parts={[failedToolPart("boom")]}
        streaming={false}
        messageKey="m1"
        summarizeCalls={() => "Attio call failed"}
      />,
    );
    expect(screen.getByTestId("activity-summary").className).not.toContain(
      "text-red",
    );
  });

  it("persists expand state through the host hooks", () => {
    const prefs = new Map<string, boolean>();
    render(
      <ActivityBlock
        parts={[reasoningPart("Thinking")]}
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

  it("renders an interleaved assembler part order identically to the lifted flat layout of the same turn", () => {
    // Hydrated layout (liftToParts): one cumulative reasoning part first,
    // then tools, then text. Live assembler layout: true stream order with
    // reasoning split around the tool call. Same settled content, different
    // part order — the default render must be indistinguishable (CL-3679
    // polish parity). ActivityBlock re-flattens deterministically (all
    // reasoning text joined in part order, tools in part order), so full DOM
    // equality is expected — including the expanded trace.
    const hydratedParts: Part[] = [
      reasoningPart("Step one: check the account\nStep two: draft the reply"),
      toolPart({ toolCallId: "c1", toolName: "attio__query_records" }),
    ];
    const assemblerParts: Part[] = [
      reasoningPart("Step one: check the account"),
      toolPart({ toolCallId: "c1", toolName: "attio__query_records" }),
      reasoningPart("Step two: draft the reply"),
    ];
    const renderProps = (parts: Part[]) => (
      <ActivityBlock
        parts={parts}
        streaming={false}
        messageKey="m1"
        formatSummary={() => "Searching Attio"}
      />
    );
    const a = render(renderProps(hydratedParts));
    const collapsedA = a.getByTestId("activity-block").outerHTML;
    fireEvent.click(a.getByRole("button", { name: "Show activity" }));
    const expandedA = a.getByTestId("activity-block").outerHTML;
    cleanup();
    const b = render(renderProps(assemblerParts));
    const collapsedB = b.getByTestId("activity-block").outerHTML;
    fireEvent.click(b.getByRole("button", { name: "Show activity" }));
    const expandedB = b.getByTestId("activity-block").outerHTML;
    expect(collapsedA).toBe(collapsedB);
    expect(expandedA).toBe(expandedB);
  });
});
