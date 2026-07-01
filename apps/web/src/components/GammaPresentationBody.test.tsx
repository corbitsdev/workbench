/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import GammaPresentationBody from "./GammaPresentationBody";

afterEach(() => {
  cleanup();
});

function renderContent(content: string) {
  return render(React.createElement(GammaPresentationBody, { content }));
}

const deck = {
  url: "https://gamma.app/docs/Building-abc",
  description: "A deck about building on Interchange",
  gammaId: "abc",
};

describe("GammaPresentationBody", () => {
  it("renders the deck iframe and its description from structured content", () => {
    const { container } = renderContent(JSON.stringify(deck));

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(deck.url);
    expect(screen.getByText(deck.description)).not.toBeNull();
  });

  it("shows a fallback and no iframe for non-JSON content", () => {
    const { container } = renderContent("not-json");
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/invalid or unavailable/i)).not.toBeNull();
  });

  it("shows a fallback for JSON missing required fields", () => {
    const { container } = renderContent(
      JSON.stringify({ url: deck.url, gammaId: "abc" }),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("rejects a non-https deck url", () => {
    const { container } = renderContent(
      JSON.stringify({ ...deck, url: "http://gamma.app/docs/abc" }),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});
