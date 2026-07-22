/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const getOwnerWorkUnitHealth = mock(async () => ({
  byStatus: { pending: 0 },
  oldestPendingAgeMs: null,
  deadCount: 1,
  agedLeasedCount: 0,
}));
const getOwnerDeadWorkUnits = mock(async () => [
  {
    id: "wu_1",
    tenantId: "t1",
    kind: "granola_call",
    idempotencyKey: "key-1",
    status: "dead",
    attempts: 3,
    lastError: "boom",
    updatedAt: "2026-07-20T00:00:00.000Z",
  },
]);
const getOwnerAgedLeasedWorkUnits = mock(async () => [] as unknown[]);
const retryOwnerWorkUnit = mock(async (id: string) => ({ ok: true, id }));
const discardOwnerWorkUnit = mock(async (id: string) => ({ ok: true, id }));

mock.module("../../lib/hub-api", () => ({
  getOwnerWorkUnitHealth,
  getOwnerDeadWorkUnits,
  getOwnerAgedLeasedWorkUnits,
  retryOwnerWorkUnit,
  discardOwnerWorkUnit,
}));

const { OwnerWorkUnits } = await import("./OwnerWorkUnits");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(OwnerWorkUnits),
    ),
  );
}

describe("OwnerWorkUnits", () => {
  beforeEach(() => {
    getOwnerWorkUnitHealth.mockClear();
    getOwnerDeadWorkUnits.mockClear();
    getOwnerAgedLeasedWorkUnits.mockClear();
    retryOwnerWorkUnit.mockClear();
    discardOwnerWorkUnit.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not discard until the confirmation step is accepted", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("granola_call");
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(discardOwnerWorkUnit).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: "Confirm discard" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(discardOwnerWorkUnit).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: "Discard" });
  });

  it("discards after confirmation is accepted", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("granola_call");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));

    await waitFor(() =>
      expect(discardOwnerWorkUnit).toHaveBeenCalledWith("wu_1"),
    );
  });
});
