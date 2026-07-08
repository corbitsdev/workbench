/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("../../lib/hub-api", () => ({
  setOwnerCredential: () => Promise.reject(new Error("not used in this test")),
  clearOwnerCredential: () =>
    Promise.reject(new Error("not used in this test")),
}));

import type { OwnerCredentialState } from "@workbench/shared";
import { CredentialRow } from "./CredentialRow";

function renderRow(credential: OwnerCredentialState) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CredentialRow credential={credential} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("CredentialRow (catalog-driven)", () => {
  it("shows the platforms a multi-platform credential powers", () => {
    renderRow({
      providerName: "scrapecreators",
      label: "ScrapeCreators",
      kind: "tool",
      configured: false,
      updatedAt: null,
    });
    expect(
      screen.getByText("Powers Reddit, TikTok, Instagram, Threads, Pinterest"),
    );
  });

  it("labels the secret and shows a handle field for Bluesky", () => {
    renderRow({
      providerName: "bluesky",
      label: "Bluesky",
      kind: "tool",
      configured: false,
      updatedAt: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    // App-password label instead of the default "API key"
    expect(screen.getByText("App password"));
    // Handle input (stored on metadata.baseURL) rather than a Base URL field
    expect(screen.getByText("Handle"));
    expect(screen.getByPlaceholderText("you.bsky.social"));
  });

  it("blocks saving Bluesky until the required handle is filled", () => {
    renderRow({
      providerName: "bluesky",
      label: "Bluesky",
      kind: "tool",
      configured: false,
      updatedAt: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    const save = screen.getByRole("button", {
      name: /save/i,
    }) as HTMLButtonElement;
    // App password alone is not enough — the handle is required.
    fireEvent.change(screen.getByLabelText("App password"), {
      target: { value: "xxxx-yyyy-zzzz" },
    });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Handle"), {
      target: { value: "me.bsky.social" },
    });
    expect(save.disabled).toBe(false);
  });

  it("shows no platforms or secondary field for a plain secret-only tool", () => {
    renderRow({
      providerName: "vercel",
      label: "Vercel",
      kind: "tool",
      configured: false,
      updatedAt: null,
    });
    expect(screen.queryByText(/^Powers /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /set key/i }));
    expect(screen.getByText("API key"));
    expect(screen.queryByText("Handle")).toBeNull();
    expect(screen.queryByText("Base URL")).toBeNull();
  });
});
