/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import GammaPresentationBody from "./GammaPresentationBody";

let fetchImpl: (url: string) => Promise<Response> = () =>
  Promise.resolve(new Response(null, { status: 200 }));

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: swapping the global for a test double
  (globalThis as any).fetch = mock((url: string) => fetchImpl(url));
  fetchImpl = () => Promise.resolve(new Response(null, { status: 200 }));
});

afterEach(() => {
  cleanup();
});

async function renderContent(
  content: string,
  props: { artifactId?: string; hasPdf?: boolean } = {},
) {
  const result = render(
    React.createElement(GammaPresentationBody, { content, ...props }),
  );
  // Flush the pdf-availability fetch effect.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

const deck = {
  url: "https://gamma.app/docs/Building-abc",
  description: "A deck about building on Interchange",
  gammaId: "abc",
};

describe("GammaPresentationBody", () => {
  it("renders the deck iframe and its description from structured content", async () => {
    const { container } = await renderContent(JSON.stringify(deck));

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(deck.url);
    expect(screen.getByText(deck.description)).not.toBeNull();
  });

  it("shows a fallback and no iframe for non-JSON content", async () => {
    const { container } = await renderContent("not-json");
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/invalid or unavailable/i)).not.toBeNull();
  });

  it("shows a fallback for JSON missing required fields", async () => {
    const { container } = await renderContent(
      JSON.stringify({ url: deck.url, gammaId: "abc" }),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("rejects a non-https deck url", async () => {
    const { container } = await renderContent(
      JSON.stringify({ ...deck, url: "http://gamma.app/docs/abc" }),
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("offers a PDF download pointing at the artifact download route when a PDF is present", async () => {
    await renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: true,
    });
    const link = screen.getByText(/download pdf/i).closest("a");
    expect(link?.getAttribute("href")).toContain("/artifacts/art_9/download");
    expect(link?.getAttribute("href")).not.toContain("inline=1");
  });

  it("renders the PDF inline via the inline download route and links back to Gamma when the fetch probe succeeds", async () => {
    const { container } = await renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: true,
    });
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain("/artifacts/art_9/download");
    expect(iframe?.getAttribute("src")).toContain("inline=1");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-same-origin");
    const gammaLink = screen.getByText(/open in gamma/i).closest("a");
    expect(gammaLink?.getAttribute("href")).toBe(deck.url);
  });

  it("omits the PDF download when no PDF is attached", async () => {
    await renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: false,
    });
    expect(screen.queryByText(/download pdf/i)).toBeNull();
  });

  it("omits the PDF download when the artifact id is unknown", async () => {
    await renderContent(JSON.stringify(deck), { hasPdf: true });
    expect(screen.queryByText(/download pdf/i)).toBeNull();
  });

  it("shows a fallback message and no iframe when the pdf probe fetch fails", async () => {
    fetchImpl = () => Promise.reject(new Error("network down"));
    const { container } = await renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: true,
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/could not be loaded here/i)).not.toBeNull();
    expect(screen.getByText(/download pdf/i)).not.toBeNull();
    expect(screen.getByText(/open in gamma/i)).not.toBeNull();
  });

  it("shows a fallback message and no iframe when the pdf probe returns a non-ok status", async () => {
    fetchImpl = () => Promise.resolve(new Response(null, { status: 404 }));
    const { container } = await renderContent(JSON.stringify(deck), {
      artifactId: "art_9",
      hasPdf: true,
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/could not be loaded here/i)).not.toBeNull();
  });
});
