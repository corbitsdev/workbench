/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
}));

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

let credentialsOutcome: Outcome = { kind: "resolve", data: [] };

function resolveOutcome(outcome: Outcome): Promise<unknown> {
  if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
  if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
  return new Promise(() => {});
}

mock.module("../../lib/hub-api", () => ({
  getOwnerCredentials: () => resolveOutcome(credentialsOutcome),
  setOwnerCredential: () => Promise.reject(new Error("not used in this test")),
  clearOwnerCredential: () =>
    Promise.reject(new Error("not used in this test")),
}));

import { OwnerCapabilities } from "./OwnerCapabilities";

function renderCapabilities() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerCapabilities />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  credentialsOutcome = { kind: "resolve", data: [] };
});

describe("OwnerCapabilities", () => {
  it("lists integrations, each linking to its own sub-page", () => {
    renderCapabilities();
    expect(screen.getByText("Gamma"));
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Gamma"),
    );
    expect(link?.getAttribute("href")).toBe("/owner/capabilities/gamma");
  });

  it("lists only tool-kind credentials, never a secret value", async () => {
    credentialsOutcome = {
      kind: "resolve",
      data: [
        {
          providerName: "anthropic",
          label: "Anthropic",
          kind: "inference",
          configured: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          providerName: "granola",
          label: "Granola",
          kind: "tool",
          configured: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Granola")));
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(document.body.innerHTML).not.toContain("gr-super-secret");
  });
});
