import { describe, expect, it } from "bun:test";
import {
  cleanContentForExcerpt,
  extractJsonSummary,
  isJsonContent,
  stripHtmlTags,
  stripMarkdownSyntax,
} from "./artifact-content-clean";

describe("stripMarkdownSyntax", () => {
  it("drops heading markers but keeps the heading text", () => {
    expect(stripMarkdownSyntax("# Title\nBody text")).toBe("Title\nBody text");
    expect(stripMarkdownSyntax("### Sub-heading")).toBe("Sub-heading");
  });

  it("keeps link text and drops the URL", () => {
    expect(stripMarkdownSyntax("See [our docs](https://example.com/x)")).toBe(
      "See our docs",
    );
  });

  it("keeps image alt text and drops the URL", () => {
    expect(stripMarkdownSyntax("![diagram](https://example.com/d.png)")).toBe(
      "diagram",
    );
  });

  it("drops code fence markers, keeping the code body", () => {
    expect(stripMarkdownSyntax("```ts\nconst x = 1;\n```")).toBe(
      "const x = 1;\n",
    );
  });

  it("unwraps inline code", () => {
    expect(stripMarkdownSyntax("Run `bun test` to verify")).toBe(
      "Run bun test to verify",
    );
  });

  it("strips bold and italic emphasis markers", () => {
    expect(stripMarkdownSyntax("This is **bold** and *italic* text")).toBe(
      "This is bold and italic text",
    );
    expect(stripMarkdownSyntax("__bold__ and _italic_")).toBe(
      "bold and italic",
    );
  });

  it("handles nested emphasis without leaving stray markers", () => {
    expect(stripMarkdownSyntax("**bold with *nested* emphasis**")).toBe(
      "bold with nested emphasis",
    );
  });

  it("strips blockquote and list markers", () => {
    expect(stripMarkdownSyntax("> a quote")).toBe("a quote");
    expect(stripMarkdownSyntax("- item one\n- item two")).toBe(
      "item one\nitem two",
    );
    expect(stripMarkdownSyntax("1. first\n2. second")).toBe("first\nsecond");
  });

  it("removes horizontal rules", () => {
    expect(stripMarkdownSyntax("above\n---\nbelow")).toBe("above\n\nbelow");
  });

  it("passes plain text through unchanged", () => {
    expect(stripMarkdownSyntax("Just plain prose.")).toBe("Just plain prose.");
  });
});

describe("stripHtmlTags", () => {
  it("removes tags and attributes, keeping inner text", () => {
    expect(stripHtmlTags('<p class="lead" data-x="1">Hello world</p>')).toBe(
      " Hello world ",
    );
  });

  it("removes a doctype declaration", () => {
    expect(stripHtmlTags("<!DOCTYPE html><html><body>Hi</body></html>")).toBe(
      "  Hi  ",
    );
  });

  it("removes HTML comments", () => {
    expect(stripHtmlTags("<!-- note -->Visible text")).toBe("Visible text");
  });

  it("removes script and style bodies entirely, not just the tags", () => {
    expect(
      stripHtmlTags(
        "<style>.x{color:red}</style><script>alert(1)</script>Content",
      ),
    ).toBe("Content");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtmlTags("Tom &amp; Jerry &mdash;&nbsp;forever")).toBe(
      "Tom & Jerry &mdash; forever",
    );
  });

  it("passes plain text through unchanged", () => {
    expect(stripHtmlTags("No tags here")).toBe("No tags here");
  });
});

describe("isJsonContent / extractJsonSummary", () => {
  it("recognizes a JSON object as JSON content", () => {
    expect(isJsonContent('{"a": 1}')).toBe(true);
  });

  it("recognizes a JSON array as JSON content", () => {
    expect(isJsonContent("[1, 2, 3]")).toBe(true);
  });

  it("does not treat plain prose as JSON content", () => {
    expect(isJsonContent("Just some text about {curly braces}")).toBe(false);
  });

  it("does not treat malformed JSON-looking text as JSON content", () => {
    expect(isJsonContent('{"a": 1,}')).toBe(false);
  });

  it("extracts the summary field when present", () => {
    expect(extractJsonSummary('{"summary": "A short summary", "id": 1}')).toBe(
      "A short summary",
    );
  });

  it("falls back to description, then title, in preference order", () => {
    expect(
      extractJsonSummary('{"description": "desc text", "title": "t"}'),
    ).toBe("desc text");
    expect(extractJsonSummary('{"title": "just a title"}')).toBe(
      "just a title",
    );
  });

  it("returns undefined when JSON has no usable text field", () => {
    expect(extractJsonSummary('{"id": 1, "count": 2}')).toBeUndefined();
  });

  it("returns undefined for non-JSON text", () => {
    expect(extractJsonSummary("plain text")).toBeUndefined();
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(() => extractJsonSummary('{"a": ')).not.toThrow();
    expect(extractJsonSummary('{"a": ')).toBeUndefined();
  });
});

describe("cleanContentForExcerpt", () => {
  it("resolves JSON content through its summary field", () => {
    expect(
      cleanContentForExcerpt('{"summary": "Key finding here"}', "Title"),
    ).toBe("Key finding here");
  });

  it("falls back to the artifact title when JSON has no summary field", () => {
    expect(
      cleanContentForExcerpt('{"id": 42, "count": 3}', "Fallback Title"),
    ).toBe("Fallback Title");
  });

  it("returns an empty string when JSON has no summary and no fallback title", () => {
    expect(cleanContentForExcerpt('{"id": 42}')).toBe("");
  });

  it("never renders raw JSON syntax", () => {
    const result = cleanContentForExcerpt(
      '{"id": 42, "nested": {"x": 1}}',
      "Fallback",
    );
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
  });

  it("strips markdown syntax from plain markdown content", () => {
    expect(cleanContentForExcerpt("# Heading\n**bold** text")).toBe(
      "Heading\nbold text",
    );
  });

  it("strips HTML tags from plain HTML content", () => {
    expect(cleanContentForExcerpt("<h1>Title</h1><p>Body</p>")).toBe(
      " Title  Body ",
    );
  });

  it("strips mixed HTML-in-markdown content", () => {
    expect(
      cleanContentForExcerpt("# Heading\n<strong>bold</strong> and *italic*"),
    ).toBe("Heading\n bold  and italic");
  });

  it("returns an empty string for empty content", () => {
    expect(cleanContentForExcerpt("")).toBe("");
  });

  it("handles whitespace-only content", () => {
    expect(cleanContentForExcerpt("   \n\t  ")).toBe("   \n\t  ");
  });
});
