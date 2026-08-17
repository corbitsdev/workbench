// DOM assertions for the CL-5879 markdown subset: bold, lists, and code
// render as real elements rather than literal `**`/`1.`/backtick text.
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { Markdown } from "./markdown";

function mount(text: string): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<Markdown text={text} />);
  });
  return container;
}

describe("Markdown", () => {
  test("renders **bold** as a strong element, not literal asterisks", () => {
    const el = mount("this is **bold** text");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.textContent).not.toContain("**");
  });

  test("renders a numbered list as an ordered list", () => {
    const el = mount("1. first\n2. second");
    const list = el.querySelector("ol");
    expect(list).not.toBeNull();
    const items = list?.querySelectorAll("li") ?? [];
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe("first");
    expect(items[1]?.textContent).toBe("second");
  });

  test("renders a bullet list as an unordered list", () => {
    const el = mount("- alpha\n- beta");
    const list = el.querySelector("ul");
    expect(list?.querySelectorAll("li").length).toBe(2);
  });

  test("renders inline code as a code element", () => {
    const el = mount("run `bun test` now");
    expect(el.querySelector("code")?.textContent).toBe("bun test");
  });

  test("renders a fenced code block as pre>code", () => {
    const el = mount("```\nconst x = 1;\n```");
    expect(el.querySelector("pre > code")?.textContent).toBe("const x = 1;");
  });

  test("renders a link opening in a new tab with no referrer leak", () => {
    const el = mount("see [docs](https://example.com)");
    const link = el.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  test("escapes raw HTML rather than rendering it", () => {
    const el = mount("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img");
  });

  test("plain text with no markdown renders unchanged", () => {
    const el = mount("just a normal message");
    expect(el.textContent).toBe("just a normal message");
  });
});
