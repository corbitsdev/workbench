/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { QuoteCard } from "./QuoteCard";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const quoteText = (c: HTMLElement) =>
  c.querySelector("blockquote")?.textContent?.trim() ?? "";

describe("QuoteCard", () => {
  it("renders a non-empty quote in a blockquote", () => {
    const { container } = render(<QuoteCard />);
    expect(quoteText(container).length).toBeGreaterThan(0);
  });

  it("falls back to the first quote when the stored index is invalid", () => {
    localStorage.setItem("cw-quote-index", "not-a-number");

    const { container } = render(<QuoteCard />);

    expect(quoteText(container).length).toBeGreaterThan(0);
    // Invalid stored index is rejected by the arktype boundary and the
    // rotation restarts at index 0, persisting it back.
    expect(localStorage.getItem("cw-quote-index")).toBe("0");
  });

  it("advances from a valid stored index", () => {
    localStorage.setItem("cw-quote-index", "0");

    render(<QuoteCard />);

    expect(localStorage.getItem("cw-quote-index")).toBe("1");
  });

  it("advances to a different quote on the next load", () => {
    const first = render(<QuoteCard />);
    const q1 = quoteText(first.container);
    first.unmount();

    const second = render(<QuoteCard />);
    const q2 = quoteText(second.container);

    expect(q2).not.toBe(q1);
  });
});
