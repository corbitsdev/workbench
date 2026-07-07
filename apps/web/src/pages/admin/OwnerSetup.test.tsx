/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

let outcome: Outcome = { kind: "pending" };
mock.module("../../lib/hub-api", () => ({
  getOwnerSetup: () => {
    if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
    if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
    return new Promise(() => {});
  },
}));

import { OwnerSetup } from "./OwnerSetup";

function renderSetup() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerSetup />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OwnerSetup", () => {
  it("renders tenant identity and deployed workflow kinds", async () => {
    outcome = {
      kind: "resolve",
      data: {
        tenantId: "ten_root",
        tenantName: "Acme Workbench",
        tenantSlug: "acme",
        parentTenantId: null,
        deployedWorkflowKinds: ["brief-builder", "seo-audit"],
      },
    };
    renderSetup();
    await waitFor(() => expect(screen.getByText("Acme Workbench")));
    expect(screen.getByText("acme"));
    expect(screen.getByText("brief-builder"));
    expect(screen.getByText("seo-audit"));
    expect(screen.getByText(/organization root/i));
  });

  it("shows an empty state when no workflows are deployed", async () => {
    outcome = {
      kind: "resolve",
      data: {
        tenantId: "ten_root",
        tenantName: "Acme",
        tenantSlug: "acme",
        parentTenantId: null,
        deployedWorkflowKinds: [],
      },
    };
    renderSetup();
    await waitFor(() => expect(screen.getByText(/no workflows are deployed/i)));
  });

  it("shows a plain-language error, not a raw error, on failure", async () => {
    outcome = { kind: "reject" };
    renderSetup();
    await waitFor(() =>
      expect(screen.getByText(/could not load the workbench setup/i)),
    );
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("shows a loading state while pending", () => {
    outcome = { kind: "pending" };
    renderSetup();
    expect(screen.getByText(/loading/i));
  });
});
