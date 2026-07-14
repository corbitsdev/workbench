/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { ToolNarrative } from "./ToolNarrative";
import { type ToolCall } from "./types";

afterEach(() => {
  cleanup();
});

describe("ToolNarrative", () => {
  it("renders the tool name and a query summary from arguments", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "minimax m3", numResults: 5 },
        result: "some results",
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    screen.getByText("Exa search");
    screen.getByText("· minimax m3");
  });

  it("suppresses the raw arg chip when a formatSummary is supplied", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "@workbench/tools-exa/exa:exa_search",
        arguments: { query: "minimax m3", numResults: 5 },
        result: "some results",
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Searching the web for minimax m3"}
      />,
    );
    screen.getByText("Searching the web for minimax m3");
    // The formatter owns the line, so the duplicate "· minimax m3" chip is gone.
    expect(screen.queryByText("· minimax m3")).toBeNull();
  });

  it("reveals the result when an expandable row is clicked", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "minimax m3" },
        result: "the full result body",
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.queryByText("the full result body")).toBeNull();
    fireEvent.click(screen.getByText("Exa search"));
    screen.getByText("the full result body");
  });

  it("shows the error result for a failed tool call", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "x" },
        result: "No matching grants for tool:exa_search/invoke",
        isError: true,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    fireEvent.click(screen.getByText("Exa search"));
    screen.getByText("No matching grants for tool:exa_search/invoke");
  });

  it("does not expand a pending call", () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "Exa Search", arguments: { query: "x" } },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    // defaultSummary sentence-cases the label; pending rows stay non-expandable.
    fireEvent.click(screen.getByText("Exa search"));
    // No result to show; the args pre block must not appear.
    expect(screen.queryByText(/"query"/)).toBeNull();
  });

  it("uses formatSummary for pending rows instead of the raw wire name", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "attio__create_record",
        arguments: {
          object: "companies",
          values: { name: "Acme" },
        },
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Creating an Attio record for Acme"}
      />,
    );
    screen.getByText("Creating an Attio record for Acme");
    expect(screen.queryByText("attio__create_record")).toBeNull();
    expect(screen.queryByText(/attio__/)).toBeNull();
  });

  it("renders quiet tools as reasoning-style text without checkmarks or expand chrome", () => {
    const calls: ToolCall[] = [
      {
        id: "q1",
        name: "search_tools",
        arguments: { query: "crm" },
        result: "[]",
        isError: false,
      },
      {
        id: "r1",
        name: "attio__query_records",
        result: "[]",
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={(c) =>
          c.name === "search_tools" ? "Searching Workbench…" : "Searching Attio"
        }
        isQuietTool={(name) => name === "search_tools"}
      />,
    );
    const quiet = screen.getByTestId("quiet-tool-line");
    expect(quiet.textContent).toBe("Searching Workbench…");
    // Quiet line is plain text — not a button with a checkmark.
    expect(quiet.closest("button")).toBeNull();
    screen.getByText("Searching Attio");
  });

  it("excludes quiet tools from the collapsed tool count", () => {
    const calls: ToolCall[] = [
      { id: "q1", name: "search_tools", result: "[]", isError: false },
      { id: "q2", name: "load_tools", result: "ok", isError: false },
      {
        id: "r1",
        name: "attio__query_records",
        result: "[]",
        isError: false,
      },
      { id: "r2", name: "exa__search", result: "[]", isError: false },
      { id: "r3", name: "linear__get_issue", result: "{}", isError: false },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        formatSummary={(c) => c.name}
        summarizeCalls={() => "Did three things"}
        isQuietTool={(name) => name === "search_tools" || name === "load_tools"}
      />,
    );
    // Collapse threshold is 3 real tools — quiet ones do not pad the count.
    screen.getByText("Did three things");
    screen.getByText(/· 3 tools/);
    // Quiet lines no longer float above the summary — they live inside the
    // expandable chronology.
    expect(screen.queryByTestId("quiet-tool-line")).toBeNull();
    fireEvent.click(screen.getByText("Did three things"));
    expect(screen.getAllByTestId("quiet-tool-line")).toHaveLength(2);
  });

  it("renders quiet and real calls interleaved in original call order", () => {
    const calls: ToolCall[] = [
      { id: "r1", name: "attio__query_records", result: "[]", isError: false },
      { id: "q1", name: "search_tools", result: "[]", isError: false },
      { id: "r2", name: "exa__search", result: "[]", isError: false },
    ];
    const { container } = render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={(c) => `row-${c.id}`}
        isQuietTool={(name) => name === "search_tools"}
      />,
    );
    const text = container.textContent ?? "";
    const positions = ["row-r1", "row-q1", "row-r2"].map((s) =>
      text.indexOf(s),
    );
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThan(positions[0] ?? 0);
    expect(positions[2]).toBeGreaterThan(positions[1] ?? 0);
  });

  it("keeps quiet lines in the marker column", () => {
    const calls: ToolCall[] = [
      { id: "q1", name: "search_tools", result: "[]", isError: false },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Searching Workbench…"}
        isQuietTool={() => true}
      />,
    );
    const quiet = screen.getByTestId("quiet-tool-line");
    // The quiet line sits inside a marker-column row, aligned with tool rows.
    expect(
      quiet
        .closest('[data-testid="quiet-tool-row"]')
        ?.querySelector('[data-testid="tool-marker-spacer"]') ?? null,
    ).not.toBeNull();
  });

  it("shows a friendly result and never dumps raw JSON when formatResult is set", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "attio__create_record",
        arguments: { object: "companies", values: { name: "Acme" } },
        result: JSON.stringify({ id: { record_id: "rec_1" }, values: {} }),
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Creating an Attio record for Acme"}
        formatResult={() => "Done"}
      />,
    );
    fireEvent.click(screen.getByText("Creating an Attio record for Acme"));
    screen.getByText("Done");
    expect(screen.queryByText(/record_id/)).toBeNull();
    expect(screen.queryByText(/"object"/)).toBeNull();
  });

  it("still expands structured UI blocks when formatResult is set", () => {
    const documentResult = JSON.stringify({
      kind: "document",
      title: "Outreach draft",
      source: "Hello Acme,",
    });
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "draft_document",
        arguments: {},
        result: documentResult,
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Drafting a document"}
        formatResult={() => "Done"}
      />,
    );
    fireEvent.click(screen.getByText("Drafting a document"));
    screen.getByText("Outreach draft");
    // Structured UI wins over the short friendly outcome.
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("never renders a checkmark for settled tool calls", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "attio__query_records",
        arguments: { query: "acme" },
        result: "[]",
        isError: false,
      },
    ];
    const { container } = render(<ToolNarrative toolCalls={calls} />);
    expect(
      container.querySelector('polyline[points="20 6 9 17 4 12"]'),
    ).toBeNull();
  });

  it("marks settled external tools with a bullet and internal tools with none", () => {
    const calls: ToolCall[] = [
      {
        id: "e1",
        name: "attio__query_records",
        result: "[]",
        isError: false,
      },
      { id: "i1", name: "memory_save", result: "ok", isError: false },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={(c) =>
          c.name === "memory_save" ? "Saving a memory" : "Searching Attio"
        }
        isExternalTool={(name) => name.includes("__")}
      />,
    );
    expect(screen.getAllByTestId("tool-marker-bullet")).toHaveLength(1);
    // Internal row still renders (and stays expandable), just without a marker.
    const internal = screen.getByText("Saving a memory");
    expect(
      internal
        .closest("button")
        ?.querySelector('[data-testid="tool-marker-bullet"]') ?? null,
    ).toBeNull();
  });

  it("renders a host-supplied brand marker for external tools when provided", () => {
    const calls: ToolCall[] = [
      {
        id: "e1",
        name: "linear__list_issues",
        result: "[]",
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => "Looking through Linear issues"}
        isExternalTool={() => true}
        renderToolMarker={() => (
          <span data-testid="tool-provider-logo">linear</span>
        )}
      />,
    );
    screen.getByTestId("tool-provider-logo");
    expect(screen.queryByTestId("tool-marker-bullet")).toBeNull();
  });

  it("keeps a distinct error marker on failed tool calls", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "attio__create_record",
        result: "boom",
        isError: true,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        isExternalTool={(name) => name.includes("__")}
      />,
    );
    expect(screen.getByTestId("tool-marker-error")).toBeDefined();
    expect(screen.queryByTestId("tool-marker-bullet")).toBeNull();
  });

  it("uses a bullet, not a checkmark, on the collapsed summary line", () => {
    const calls = [
      settled("c1", "attio__get_record"),
      settled("c2", "attio__get_record"),
      settled("c3", "linear__get_issue"),
    ];
    const { container } = render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
        isExternalTool={(name) => name.includes("__")}
      />,
    );
    screen.getByText("Did a bunch of things");
    expect(
      container.querySelector('polyline[points="20 6 9 17 4 12"]'),
    ).toBeNull();
    expect(screen.getAllByTestId("tool-marker-bullet").length).toBeGreaterThan(
      0,
    );
  });

  it("renders the collapsed summary plain when every call is internal", () => {
    const calls = [
      settled("c1", "memory_save"),
      settled("c2", "write_artifact"),
      settled("c3", "workflow_start"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did internal things"}
        formatSummary={(c) => `summary-of-${c.id}`}
        isExternalTool={(name) => name.includes("__")}
      />,
    );
    screen.getByText("Did internal things");
    expect(screen.queryByTestId("tool-marker-bullet")).toBeNull();
  });

  it('summarizes a non-priority arg as "key: value" when no known key is present', () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "fetch_rows", arguments: { limit: 10 }, result: "ok" },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    screen.getByText("· limit: 10");
  });

  it("omits the summary when arguments have no stringifiable scalar values", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "apply_filter",
        arguments: { rules: [1, 2, 3] },
        result: "ok",
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.queryByText(/·/)).toBeNull();
  });

  const settled = (id: string, name: string): ToolCall => ({
    id,
    name,
    arguments: { query: "x" },
    result: "ok",
    isError: false,
  });

  it("collapses a completed turn of 3+ calls into a summary line when compact is on", () => {
    const calls = [
      settled("c1", "attio_get_record"),
      settled("c2", "attio_get_record"),
      settled("c3", "linear_get_issue"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    screen.getByText("Did a bunch of things");
    screen.getByText("· 3 tools");
    // Individual rows are hidden until expanded.
    expect(screen.queryByText("summary-of-c1")).toBeNull();
    fireEvent.click(screen.getByText("Did a bunch of things"));
    // Roll-up line hides when expanded — detail replaces it, not stacks under it.
    expect(screen.queryByTestId("tool-group-summary")).toBeNull();
    expect(screen.queryByText("· 3 tools")).toBeNull();
    screen.getByTestId("tool-group-detail");
    screen.getByText("summary-of-c1");
    screen.getByText("summary-of-c3");
  });

  it("does not collapse while any call is still in flight", () => {
    const calls: ToolCall[] = [
      settled("c1", "attio_get_record"),
      settled("c2", "attio_get_record"),
      { id: "c3", name: "linear_get_issue", arguments: { query: "x" } },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    expect(screen.queryByText("Did a bunch of things")).toBeNull();
    screen.getByText("summary-of-c1");
  });

  it("does not collapse below the threshold", () => {
    const calls = [
      settled("c1", "attio_get_record"),
      settled("c2", "linear_get_issue"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    expect(screen.queryByText("Did a bunch of things")).toBeNull();
    screen.getByText("summary-of-c1");
  });

  it("renders the flat list when compact is off, even for many calls", () => {
    const calls = [
      settled("c1", "attio_get_record"),
      settled("c2", "attio_get_record"),
      settled("c3", "linear_get_issue"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    expect(screen.queryByText("Did a bunch of things")).toBeNull();
    screen.getByText("summary-of-c1");
    screen.getByText("summary-of-c3");
  });

  it("hides the tool summary line while tool output is expanded", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "minimax m3" },
        result: "the full result body",
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    fireEvent.click(screen.getByTestId("tool-row-summary"));
    expect(screen.queryByTestId("tool-row-summary")).toBeNull();
    expect(screen.queryByTestId("tool-row-args")).toBeNull();
    screen.getByTestId("tool-row-detail");
    screen.getByText("the full result body");
  });

  it("restores the tool summary line when tool output is collapsed again", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "minimax m3" },
        result: "the full result body",
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    const toggle = screen.getByTestId("tool-row-summary").closest("button");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.queryByTestId("tool-row-summary")).toBeNull();
    fireEvent.click(toggle!);
    screen.getByTestId("tool-row-summary");
    expect(screen.queryByTestId("tool-row-detail")).toBeNull();
  });

  it("hides the compact roll-up summary while the tool group is expanded", () => {
    const calls = [
      settled("c1", "attio_get_record"),
      settled("c2", "attio_get_record"),
      settled("c3", "linear_get_issue"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    const toggle = screen.getByTestId("tool-group-summary").closest("button");
    fireEvent.click(toggle!);
    expect(screen.queryByTestId("tool-group-summary")).toBeNull();
    screen.getByTestId("tool-group-detail");
  });

  it("restores the compact roll-up summary when the tool group is collapsed again", () => {
    const calls = [
      settled("c1", "attio_get_record"),
      settled("c2", "attio_get_record"),
      settled("c3", "linear_get_issue"),
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        compact
        summarizeCalls={() => "Did a bunch of things"}
        formatSummary={(c) => `summary-of-${c.id}`}
      />,
    );
    const toggle = screen.getByTestId("tool-group-summary").closest("button");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.queryByTestId("tool-group-summary")).toBeNull();
    fireEvent.click(toggle!);
    screen.getByTestId("tool-group-summary");
    screen.getByText("· 3 tools");
    expect(screen.queryByTestId("tool-group-detail")).toBeNull();
  });

  it("exposes aria-expanded and a collapse label on an expanded tool row", () => {
    const calls: ToolCall[] = [
      {
        id: "c1",
        name: "Exa Search",
        arguments: { query: "minimax m3" },
        result: "the full result body",
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    const toggle = screen.getByTestId("tool-row-summary").closest("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle!);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe(
      "Collapse Exa search · minimax m3",
    );
  });
});
