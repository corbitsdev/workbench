/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Force the brands API "configured" so the fetch path is exercised; the real
// values come from Vite env at runtime.
mock.module("../lib/brands", () => ({
  brandsApi: { base: "https://brands.test", key: "test-key", enabled: true },
  brandLogoEndpoint: (filename: string) =>
    `https://brands.test/svg/${filename}`,
}));

import { ProviderLogo } from "./ProviderLogo";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect /></svg>';

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("ProviderLogo", () => {
  it("renders the fetched brand logo, sending the API key in a header", async () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithClient(<ProviderLogo providerName="firecrawl" />);

    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toContain("data:image/svg+xml,");
    // Key is in the header, never the URL.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://brands.test/svg/firecrawl.svg");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "test-key",
    );
  });

  it("falls back to the generic glyph when there is no mark for the provider", () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderWithClient(
      <ProviderLogo providerName="totally-unknown" fallbackGlyph="grid" />,
    );

    // No logo => no fetch, no <img>, the glyph renders instead.
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the glyph when the logo request fails", async () => {
    const fetchMock = mock(async () => new Response("nope", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderWithClient(
      <ProviderLogo providerName="firecrawl" fallbackGlyph="grid" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the glyph when a 200 returns a non-SVG body", async () => {
    // A proxy/CDN returning an HTML error page with status 200 must not render
    // a broken <img>; it should degrade to the glyph.
    const fetchMock = mock(
      async () => new Response("<html>nope</html>", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderWithClient(
      <ProviderLogo providerName="firecrawl" fallbackGlyph="grid" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
