/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Outcome =
  | { kind: "resolve"; tenantId: string; ownerPrincipalId: string }
  | { kind: "reject" }
  | { kind: "pending" };

let outcome: Outcome = { kind: "pending" };
mock.module("../../lib/hub-api", () => ({
  getOwnerContext: () => {
    if (outcome.kind === "resolve") {
      return Promise.resolve({
        tenantId: outcome.tenantId,
        ownerPrincipalId: outcome.ownerPrincipalId,
      });
    }
    if (outcome.kind === "reject") {
      return Promise.reject(new Error("boom"));
    }
    return new Promise(() => {});
  },
}));

import { OwnerOverview } from "./OwnerOverview";

function renderOverview() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerOverview />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("OwnerOverview", () => {
  it("renders the governed tenant and owner principal on success", async () => {
    outcome = {
      kind: "resolve",
      tenantId: "ten_root_1",
      ownerPrincipalId: "prn_owner_1",
    };
    renderOverview();
    await waitFor(() => expect(screen.getByText("ten_root_1")));
    expect(screen.getByText("prn_owner_1"));
  });

  it("shows a plain-language error, not a raw error, on failure", async () => {
    outcome = { kind: "reject" };
    renderOverview();
    await waitFor(() =>
      expect(screen.getByText(/could not load owner context/i)),
    );
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("shows a loading state while the request is pending", () => {
    outcome = { kind: "pending" };
    renderOverview();
    expect(screen.getByText(/loading/i));
  });
});
