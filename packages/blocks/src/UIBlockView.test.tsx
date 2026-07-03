/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { UIBlockView } from "./UIBlockView";
import type { UIBlock } from "./ui-block";

afterEach(() => {
  cleanup();
});

describe("UIBlockView", () => {
  it("renders a document title and reveals the source when opened", () => {
    const block: UIBlock = {
      kind: "document",
      title: "ABK | Book a Demo",
      subtitle: "granola note · Jun 10",
      source: "# Call: ABK\nSummary here",
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("ABK | Book a Demo")).not.toBeNull();
    // Collapsed by default: body not shown.
    expect(screen.queryByText("Summary here")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ABK | Book a Demo/ }));
    expect(screen.getByText("Summary here")).not.toBeNull();
  });

  it("renders a table with its columns and cells", () => {
    const block: UIBlock = {
      kind: "table",
      columns: ["Pain point", "Severity"],
      rows: [["Agent degradation", "high"]],
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Pain point")).not.toBeNull();
    expect(screen.getByText("Agent degradation")).not.toBeNull();
  });

  it("fires onRespond with the selected value when a choice is clicked", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      prompt: "Which call?",
      options: [
        { id: "a", label: "ABK Demo", value: "ABK | Book a Demo" },
        { id: "b", label: "Pricing call" },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "ABK Demo" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "ABK | Book a Demo",
    });
  });

  it("falls back to the option label when a choice has no explicit value", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "b", label: "Pricing call" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Pricing call" }));
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "Pricing call",
    });
  });

  it("renders an error block message", () => {
    const block: UIBlock = { kind: "error", message: "Granola API failed" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Granola API failed")).not.toBeNull();
  });

  it("renders a plain text block as preformatted prose", () => {
    const block: UIBlock = { kind: "text", text: "just some output" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("just some output")).not.toBeNull();
  });

  it("renders a non-collapsible markdown block open with its source", () => {
    const block: UIBlock = {
      kind: "markdown",
      title: "Notes",
      source: "rendered body",
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Notes")).not.toBeNull();
    expect(screen.getByText("rendered body")).not.toBeNull();
  });

  it("keeps a collapsible markdown block closed until its header is clicked", () => {
    const block: UIBlock = {
      kind: "markdown",
      title: "Details",
      source: "hidden body",
      collapsible: true,
    };
    render(<UIBlockView block={block} />);
    expect(screen.queryByText("hidden body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("hidden body")).not.toBeNull();
  });

  it("renders a link block pointing at its url and showing its title", () => {
    const block: UIBlock = {
      kind: "link",
      url: "https://corbits.dev/report",
      title: "Quarterly report",
      description: "Q2 summary",
    };
    const { container } = render(<UIBlockView block={block} />);
    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://corbits.dev/report");
    expect(screen.getByText("Quarterly report")).not.toBeNull();
    expect(screen.getByText("Q2 summary")).not.toBeNull();
  });

  it("falls back to the url as the link label when no title is given", () => {
    const block: UIBlock = { kind: "link", url: "https://corbits.dev/raw" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("https://corbits.dev/raw")).not.toBeNull();
  });

  it("fires onAction with the document action key when an action button is clicked", () => {
    const onAction = mock(() => undefined);
    const block: UIBlock = {
      kind: "document",
      title: "Doc",
      source: "# body text",
      actions: { copy: true, download: true, saveArtifact: true },
    };
    render(<UIBlockView block={block} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /Doc/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save to artifacts" }));
    expect(onAction).toHaveBeenCalledWith("save-artifact", block);
  });

  it("recursively renders canvas children", () => {
    const block: UIBlock = {
      kind: "canvas",
      title: "Last call",
      blocks: [
        { kind: "document", title: "Doc", source: "# x" },
        { kind: "choice", options: [{ id: "a", label: "Draft follow-up" }] },
      ],
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Doc")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Draft follow-up" }),
    ).not.toBeNull();
  });
});
