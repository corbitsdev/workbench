/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MarkdownBlock } from "./Markdown";

afterEach(() => {
  cleanup();
});

describe("MarkdownBlock", () => {
  it("renders ordered lists as <ol>/<li> without leaking the numeral", () => {
    render(
      React.createElement(MarkdownBlock, {
        text: "1. First point\n2. Second point",
      }),
    );
    const item = screen.getByText("First point");
    const li = item.closest("li");
    if (li === null) throw new Error("Expected ordered list item element");
    if (li.closest("ol") === null)
      throw new Error("Expected list item inside an <ol>");
  });

  it("renders bold lead-ins inside an ordered list item", () => {
    render(
      React.createElement(MarkdownBlock, {
        text: "1. **Lead.** Then detail.",
      }),
    );
    const strong = screen.getByText("Lead.");
    if (strong.tagName !== "STRONG")
      throw new Error("Expected bold lead-in to render as <strong>");
  });

  it("renders single-asterisk italics as <em>", () => {
    render(
      React.createElement(MarkdownBlock, {
        text: "*Research by last30days via GTM Workbench*",
      }),
    );
    const em = screen.getByText("Research by last30days via GTM Workbench");
    if (em.tagName !== "EM")
      throw new Error("Expected italic text to render as <em>");
  });

  it("renders inline links as anchors with their href", () => {
    render(
      React.createElement(MarkdownBlock, {
        text: "See [the paper](https://example.com/x) for detail.",
      }),
    );
    const link = screen.getByRole("link", { name: "the paper" });
    if (link.getAttribute("href") !== "https://example.com/x")
      throw new Error("Expected inline link href to be preserved");
  });

  it("runs heading content through the inline renderer", () => {
    render(
      React.createElement(MarkdownBlock, {
        text: "## Heading with **bold**",
      }),
    );
    const strong = screen.getByText("bold");
    if (strong.tagName !== "STRONG")
      throw new Error("Expected bold inside heading to render as <strong>");
  });

  it("renders a horizontal rule for a --- line", () => {
    const { container } = render(
      React.createElement(MarkdownBlock, { text: "above\n\n---\n\nbelow" }),
    );
    if (container.querySelector("hr") === null)
      throw new Error("Expected a horizontal rule element");
  });
});
