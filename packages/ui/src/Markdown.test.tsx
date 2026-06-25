import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders headings as semantic elements with token text color", () => {
    render(<Markdown># Heading one</Markdown>);
    const heading = screen.getByText("Heading one");
    expect(heading.tagName).toBe("H2");
    expect(heading.className).toContain("text-text");
  });

  it("renders bold spans as <strong>, not literal asterisks", () => {
    render(<Markdown>{"A **bold** word"}</Markdown>);
    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText("**bold**")).toBeNull();
  });

  it("renders list items as <li> inside a <ul>", () => {
    render(<Markdown>{"- first\n- second"}</Markdown>);
    const first = screen.getByText("first");
    expect(first.tagName).toBe("LI");
    expect(first.closest("ul")).not.toBeNull();
  });

  it("renders links with safe target and rel attributes", () => {
    render(<Markdown>{"[site](https://example.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "site" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});
