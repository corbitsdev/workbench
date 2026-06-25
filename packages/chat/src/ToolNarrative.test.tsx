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
    screen.getByText("Exa Search");
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
    fireEvent.click(screen.getByText("Exa Search"));
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
    fireEvent.click(screen.getByText("Exa Search"));
    screen.getByText("No matching grants for tool:exa_search/invoke");
  });

  it("does not expand a pending call", () => {
    const calls: ToolCall[] = [
      { id: "c1", name: "Exa Search", arguments: { query: "x" } },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    fireEvent.click(screen.getByText("Exa Search"));
    // No result to show; the args pre block must not appear.
    expect(screen.queryByText(/"query"/)).toBeNull();
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
});
