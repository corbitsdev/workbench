/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("../lib/brands", () => ({
  brandsApi: { base: "https://brands.test", key: "test-key", enabled: true },
  brandLogoEndpoint: (filename: string) =>
    `https://brands.test/svg/${filename}`,
}));

import {
  renderChatToolMarker,
  ToolCallProviderMarker,
} from "./ToolCallProviderMarker";

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

describe("ToolCallProviderMarker", () => {
  it("renders the provider logo shell for attributable integration tools", async () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithClient(
      <ToolCallProviderMarker call={{ name: "linear__get_issue" }} />,
    );

    const shell = screen.getByTestId("tool-provider-logo");
    expect(shell.className).toContain("h-4");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://brands.test/svg/linear.svg");
    await screen.findByRole("img", { name: /linear logo/i });
  });

  it("renders nothing for internal tools with no provider attribution", () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = renderWithClient(
      <ToolCallProviderMarker call={{ name: "read_file" }} />,
    );

    expect(screen.queryByTestId("tool-provider-logo")).toBeNull();
    expect(container.firstChild).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves bare integration op ids (exa_search)", async () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithClient(<ToolCallProviderMarker call={{ name: "exa_search" }} />);

    screen.getByTestId("tool-provider-logo");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://brands.test/svg/exa-dark.svg");
  });
});

describe("renderChatToolMarker", () => {
  it("delegates to ToolCallProviderMarker with the tool call from context", async () => {
    const fetchMock = mock(async () => new Response(SVG, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithClient(
      <>
        {renderChatToolMarker({
          call: {
            id: "tc-1",
            name: "attio__create_record",
            arguments: {},
          },
          pending: false,
          isError: false,
          external: true,
        })}
      </>,
    );

    screen.getByTestId("tool-provider-logo");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://brands.test/svg/attio-dark.svg");
  });
});