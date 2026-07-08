/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

let providersOutcome: Outcome = { kind: "pending" };
let modelsOutcome: Outcome = { kind: "pending" };

function resolveOutcome(outcome: Outcome): Promise<unknown> {
  if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
  if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
  return new Promise(() => {});
}

mock.module("../../lib/hub-api", () => ({
  getTenantProviders: () => resolveOutcome(providersOutcome),
  getTenantModels: () => resolveOutcome(modelsOutcome),
}));

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: {
      id: "p1",
      tenantId: "ten_1",
      tenantSlug: "acme",
      tenantName: "Acme",
    },
    activeTenantId: "ten_1",
    setActiveWorkbench: () => {},
  }),
}));

import { OwnerModels } from "./OwnerModels";

function renderModels() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerModels />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OwnerModels", () => {
  it("renders providers and models", async () => {
    providersOutcome = {
      kind: "resolve",
      data: [{ id: "prov_1", name: "OpenAI", plugin: "openai" }],
    };
    modelsOutcome = {
      kind: "resolve",
      data: [
        {
          id: "model_1",
          canonicalName: "gpt-4o",
          displayName: "GPT-4o",
          description: null,
          offerings: [
            {
              offeringId: "off_1",
              providerId: "prov_1",
              providerName: "OpenAI",
              plugin: "openai",
              priority: 0,
            },
          ],
        },
      ],
    };
    renderModels();
    await waitFor(() => expect(screen.getAllByText("OpenAI").length).toBe(2));
    expect(screen.getByText("GPT-4o"));
    expect(screen.getByText("gpt-4o"));
  });

  it("shows empty states when no providers or models exist", async () => {
    providersOutcome = { kind: "resolve", data: [] };
    modelsOutcome = { kind: "resolve", data: [] };
    renderModels();
    await waitFor(() =>
      expect(screen.getByText(/no providers are configured/i)),
    );
    expect(screen.getByText(/no models are resolved/i));
  });

  it("shows a plain-language error, not a raw error, on failure", async () => {
    providersOutcome = { kind: "reject" };
    modelsOutcome = { kind: "resolve", data: [] };
    renderModels();
    await waitFor(() =>
      expect(screen.getByText(/could not load the model catalog/i)),
    );
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("shows a loading state while pending", () => {
    providersOutcome = { kind: "pending" };
    modelsOutcome = { kind: "pending" };
    renderModels();
    expect(screen.getByText(/loading/i));
  });
});
