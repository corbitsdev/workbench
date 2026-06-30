import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders headings as their semantic level with token text color", () => {
    render(<Markdown># Heading one</Markdown>);
    const heading = screen.getByText("Heading one");
    expect(heading.tagName).toBe("H1");
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

  it("renders links opening in a new tab with a safe rel", () => {
    render(<Markdown>{"[site](https://example.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "site" });
    expect(link.getAttribute("href")).toContain("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("renders a GFM pipe table into a real <table> with header and body cells", () => {
    render(
      <Markdown>
        {"| Metric | Value |\n| --- | --- |\n| Revenue | 42 |"}
      </Markdown>,
    );
    const header = screen.getByText("Metric");
    expect(header.tagName).toBe("TH");
    const cell = screen.getByText("Revenue");
    expect(cell.tagName).toBe("TD");
    expect(cell.closest("table")).not.toBeNull();
  });

  it("renders a fenced code block as a horizontally-scrolling <pre> surface", () => {
    const { container } = render(
      <Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>,
    );
    const pre = container.querySelector("pre");
    if (pre === null) throw new Error("Expected a <pre> for the fenced block");
    expect(pre.className).toContain("overflow-x-auto");
    const code = pre.querySelector("code");
    if (code === null) throw new Error("Expected a <code> inside the <pre>");
    // The chip is shed inside <pre> via the `.wb-markdown pre code` CSS reset.
    // The structural contract asserted here is that block code lives in the
    // <pre> surface (RTL cannot observe the external stylesheet).
    expect(code.closest("pre")).toBe(pre);
  });

  it("styles inline code as a bordered chip, distinct from block code", () => {
    render(<Markdown>{"Use the `build` command"}</Markdown>);
    const code = screen.getByText("build");
    expect(code.tagName).toBe("CODE");
    expect(code.className).toContain("border-border");
  });

  it("renders GFM strikethrough as <del>", () => {
    render(<Markdown>{"~~gone~~"}</Markdown>);
    const del = screen.getByText("gone");
    expect(del.tagName).toBe("DEL");
  });

  it("renders GFM footnote citations as a <sup> ref and a footnotes section", () => {
    const { container } = render(
      <Markdown>
        {"A claim[^1].\n\n[^1]: Source title — https://example.com"}
      </Markdown>,
    );
    // The citation marker is the only `sup > a` markdown produces — the hook the
    // token-driven citation-pill CSS keys on (the data-footnote-ref attribute is
    // stripped by streamdown's sanitize, so the structure is the contract).
    const ref = container.querySelector("sup a");
    if (ref === null) throw new Error("Expected a <sup> footnote reference");
    expect(ref.getAttribute("href")).toContain("fn-1");
    const footnotes = container.querySelector("section.footnotes");
    if (footnotes === null)
      throw new Error("Expected a footnotes section to collect the sources");
  });

  it("applies a caller className to the rendered surface", () => {
    const { container } = render(
      <Markdown className="max-w-[68ch]">text</Markdown>,
    );
    const root = container.querySelector(".wb-markdown");
    if (root === null) throw new Error("Expected the wb-markdown surface");
    expect(root.className).toContain("max-w-[68ch]");
  });
});
