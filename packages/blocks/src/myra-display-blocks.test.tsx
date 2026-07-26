/// <reference types="bun" />
import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UIBlockView } from "./UIBlockView";
import { isUIBlock, type UIBlock } from "./ui-block";
import { UI_BLOCK_KIND_INVENTORY } from "./myra-ui-catalog";

describe("Myra display blocks (CL-3547)", () => {
  it("inventory covers every known UIBlock kind", () => {
    const kinds = UI_BLOCK_KIND_INVENTORY.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(
      [
        "canvas",
        "card",
        "choice",
        "comparison",
        "document",
        "error",
        "form",
        "link",
        "list",
        "markdown",
        "multiSelect",
        "preview",
        "progress",
        "reviewList",
        "table",
        "text",
      ].sort(),
    );
  });

  it("accepts a well-formed card block", () => {
    expect(
      isUIBlock({
        kind: "card",
        title: "Q2 pipeline",
        body: "Three deals need follow-up.",
        badge: "CRM",
      }),
    ).toBe(true);
  });

  it("renders a card with title, badge, and markdown body", () => {
    const block: UIBlock = {
      kind: "card",
      title: "Acme Corp",
      subtitle: "Enterprise · $120k",
      badge: "Hot",
      body: "**Next step:** send revised proposal.",
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Acme Corp")).not.toBeNull();
    expect(screen.getByText("Enterprise · $120k")).not.toBeNull();
    expect(screen.getByText("Hot")).not.toBeNull();
    expect(screen.getByText(/revised proposal/)).not.toBeNull();
  });

  it("accepts a well-formed list block", () => {
    expect(
      isUIBlock({
        kind: "list",
        items: [{ title: "First" }, { title: "Second" }],
      }),
    ).toBe(true);
  });

  it("renders a list with descriptions and meta", () => {
    const block: UIBlock = {
      kind: "list",
      title: "Open tasks",
      items: [
        {
          id: "1",
          title: "Send recap",
          description: "From yesterday's call",
          meta: "Due today",
        },
        { id: "2", title: "Update CRM", badge: "Attio" },
      ],
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Open tasks")).not.toBeNull();
    expect(screen.getByText("Send recap")).not.toBeNull();
    expect(screen.getByText("From yesterday's call")).not.toBeNull();
    expect(screen.getByText("Due today")).not.toBeNull();
    expect(screen.getByText("Attio")).not.toBeNull();
  });

  it("accepts a well-formed preview block", () => {
    expect(
      isUIBlock({
        kind: "preview",
        url: "https://example.com/deck",
        title: "Board deck",
      }),
    ).toBe(true);
  });

  it("renders a preview as a linked card with optional decorative thumbnail", () => {
    const block: UIBlock = {
      kind: "preview",
      url: "https://example.com/report.pdf",
      title: "Weekly report",
      description: "Finance summary for leadership",
      imageUrl: "https://example.com/thumb.png",
    };
    render(<UIBlockView block={block} />);
    const link = screen.getByRole("link", { name: /Weekly report/i });
    expect(link.getAttribute("href")).toBe("https://example.com/report.pdf");
    expect(screen.getByText("Finance summary for leadership")).not.toBeNull();
    const thumb = screen.getByRole("presentation");
    expect(thumb.tagName).toBe("IMG");
    expect(thumb.getAttribute("alt")).toBe("");
    expect(thumb.getAttribute("src")).toBe("https://example.com/thumb.png");
  });

  it("renders choice options as cards when descriptions are present", () => {
    const block: UIBlock = {
      kind: "choice",
      prompt: "Which note?",
      options: [
        { id: "a", label: "ABK sync", description: "Granola · 42 min" },
        { id: "b", label: "Investor call", description: "Granola · 18 min" },
      ],
    };
    const onRespond = mock(() => Promise.resolve());
    render(<UIBlockView block={block} onRespond={onRespond} />);
    expect(screen.getByTestId("choice-card-grid")).not.toBeNull();
    expect(screen.getByText("Granola · 42 min")).not.toBeNull();
  });

  it("submits a choice from a card option", async () => {
    const user = userEvent.setup();
    const block: UIBlock = {
      kind: "choice",
      options: [
        {
          id: "a",
          label: "Approve",
          description: "Ship as-is",
          value: "approve",
        },
      ],
    };
    const onRespond = mock(() => Promise.resolve());
    render(<UIBlockView block={block} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: /Approve/i }));
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ blockKind: "choice", value: "approve" }),
    );
  });
});
