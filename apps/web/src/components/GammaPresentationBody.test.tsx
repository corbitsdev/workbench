/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import GammaPresentationBody from "./GammaPresentationBody";

afterEach(() => {
  cleanup();
});

function renderContent(
  content: string,
  props: { artifactId?: string; hasPdf?: boolean } = {},
) {
  return render(
    React.createElement(GammaPresentationBody, { content, ...props }),
  );
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

  it("offers a PDF download pointing at the artifact download route when a PDF is present", () => {
    renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: true,
    });
    const link = screen.getByText(/download pdf/i).closest("a");
    expect(link?.getAttribute("href")).toContain("/artifacts/art_9/download");
  });

  it("omits the PDF download when no PDF is attached", () => {
    renderContent(JSON.stringify(deck), { artifactId: "art_9", hasPdf: false });
    expect(screen.queryByText(/download pdf/i)).toBeNull();
  });

  it("omits the PDF download when the artifact id is unknown", () => {
    renderContent(JSON.stringify(deck), { hasPdf: true });
    expect(screen.queryByText(/download pdf/i)).toBeNull();
  });
});
