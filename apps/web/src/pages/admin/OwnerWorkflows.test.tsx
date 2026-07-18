/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let workflows: { kind: string; enabled: boolean }[] = [];
const setEnabled = mock((_kind: string, _enabled: boolean) =>
  Promise.resolve({ kind: _kind, enabled: _enabled }),
);
mock.module("../../lib/hub-api", () => ({
  getOwnerWorkflows: () => Promise.resolve({ workflows }),
  setOwnerWorkflowEnabled: (kind: string, enabled: boolean) =>
    setEnabled(kind, enabled),
}));

import { OwnerWorkflows } from "./OwnerWorkflows";

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <OwnerWorkflows />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  setEnabled.mockClear();
});

const btn = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

describe("OwnerWorkflows", () => {
  it("lists deployed workflows with the right enable/disable action", async () => {
    workflows = [
      { kind: "brief-builder", enabled: true },
      { kind: "seo-audit", enabled: false },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText("brief-builder")));
    expect(screen.getByText("seo-audit"));
    // Enabled workflow offers Disable; disabled offers Enable.
    expect(btn("Disable")).toBeTruthy();
    expect(btn("Enable")).toBeTruthy();
  });

  it("disables an enabled workflow (flips the enabled flag through the API)", async () => {
    workflows = [{ kind: "brief-builder", enabled: true }];
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("brief-builder")));
    await user.click(btn("Disable"));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));
    expect(setEnabled.mock.calls[0]).toEqual(["brief-builder", false]);
  });

  it("shows an empty state when nothing is deployed", async () => {
    workflows = [];
    renderPage();
    await waitFor(() => expect(screen.getByText(/no workflows are deployed/i)));
  });

  it("only disables the row whose toggle is in flight, not every row", async () => {
    workflows = [
      { kind: "brief-builder", enabled: true },
      { kind: "seo-audit", enabled: true },
    ];
    let resolveToggle: (() => void) | undefined;
    setEnabled.mockImplementationOnce(
      (kind: string, enabled: boolean) =>
        new Promise((resolve) => {
          resolveToggle = () => resolve({ kind, enabled });
        }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("brief-builder")));

    const buttons = () =>
      Array.from(document.querySelectorAll("button")).filter(
        (b) => b.textContent === "Disable",
      ) as HTMLButtonElement[];
    const [briefBuilderBtn, seoAuditBtn] = buttons();
    await user.click(briefBuilderBtn);

    await waitFor(() => expect(briefBuilderBtn.disabled).toBe(true));
    expect(seoAuditBtn.disabled).toBe(false);

    resolveToggle?.();
    await waitFor(() => expect(briefBuilderBtn.disabled).toBe(false));
  });
});
