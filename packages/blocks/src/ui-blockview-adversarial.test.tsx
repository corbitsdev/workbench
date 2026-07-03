/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { UIBlockView } from "./UIBlockView";
import { parseToolResult } from "./ui-block";
import type { UIBlock } from "./ui-block";

afterEach(() => {
  cleanup();
});

describe("UIBlockView adversarial", () => {
  it("table block with object cells passes the guard then crashes React", () => {
    const block = parseToolResult(
      JSON.stringify({ kind: "table", columns: ["a"], rows: [[{ x: 1 }]] }),
    );
    expect(block.kind).toBe("table");
    let threw = false;
    try {
      render(<UIBlockView block={block} />);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("table block with null row passes the guard then crashes React", () => {
    const block = parseToolResult(
      JSON.stringify({ kind: "table", columns: ["a"], rows: [null] }),
    );
    expect(block.kind).toBe("table");
    if (block.kind === "table") {
      let threw = false;
      try {
        render(<UIBlockView block={block} />);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  it("choice option with object value posts the object through onRespond", () => {
    const block = parseToolResult(
      JSON.stringify({
        kind: "choice",
        options: [{ id: "a", label: "A", value: { evil: 1 } }],
      }),
    );
    expect(block.kind).toBe("choice");
    const onRespond = mock(() => undefined);
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(JSON.stringify(onRespond.mock.calls[0])).toBe(
      JSON.stringify([{ blockKind: "choice", value: { evil: 1 } }]),
    );
  });

  it("HTML/markdown in a choice option label renders as text, not markup", () => {
    const block: UIBlock = {
      kind: "choice",
      options: [
        { id: "x", label: "<img src=x onerror=alert(1)>", value: "payload" },
      ],
    };
    const { container } = render(<UIBlockView block={block} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).not.toBeNull();
  });

  it("double-clicking a choice option only fires onRespond once", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "a", label: "Go", value: "go" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    const button = screen.getByRole("button", { name: "Go" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRespond.mock.calls.length).toBe(1);
  });

  it("link block renders javascript: URLs into href unsanitized", () => {
    const block: UIBlock = { kind: "link", url: "javascript:alert(1)" };
    const { container } = render(<UIBlockView block={block} />);
    const anchor = container.querySelector("a");
    // React itself neutralizes javascript: URLs; the component does not.
    expect(anchor?.getAttribute("href")).toContain(
      "React has blocked a javascript: URL",
    );
  });
});
