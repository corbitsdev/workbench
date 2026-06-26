/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, it, expect, mock, beforeEach } from "bun:test";
import {
  cleanup,
  render,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnifiedCatalogModal } from "./UnifiedCatalogModal";

mock.module("../../hooks/use-workflow", () => ({
  useWorkflowDeployments: () => ({
    data: [
      {
        deploymentId: "dep-1",
        kind: "collateral-generation",
        status: "running",
        createdAt: "",
      },
      {
        deploymentId: "dep-2",
        kind: "presentation-generation",
        status: "running",
        createdAt: "",
      },
      {
        deploymentId: "dep-3",
        kind: "seo-enrichment",
        status: "running",
        createdAt: "",
      },
    ],
    isPending: false,
  }),
  useStartWorkflow: () => ({
    mutateAsync: async ({ kind }: { kind: string }) => ({
      runId: `started-${kind}`,
    }),
    isPending: false,
  }),
}));

function screen() {
  return within(document.body);
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("UnifiedCatalogModal", () => {
  let onClose: ReturnType<typeof mock>;
  let onWorkflowStarted: ReturnType<typeof mock>;

  beforeEach(() => {
    onClose = mock(() => undefined);
    onWorkflowStarted = mock(() => undefined);
  });

  afterEach(cleanup);

  it("renders only the workflow list with no Agents tab", async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    await waitFor(() => screen().getByText("Collateral Generation"));
    screen().getByText("Presentation Generation");
    screen().getByText("SEO Enrichment");

    expect(screen().queryByRole("button", { name: "Agents" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Workflows" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("filters workflows by search query", async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    await waitFor(() => screen().getByText("Collateral Generation"));

    const user = userEvent.setup();
    const searchInput = screen().getByPlaceholderText(/search/i);
    await user.type(searchInput, "collateral");

    screen().getByText("Collateral Generation");
    await waitFor(() =>
      expect(screen().queryByText("Presentation Generation")).toBeNull(),
    );
  });

  it("calls onWorkflowStarted with the new run id after clicking a workflow card", async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    await waitFor(() => screen().getByText("Collateral Generation"));

    fireEvent.click(screen().getAllByRole("button", { name: "Start" })[0]!);

    await waitFor(() =>
      expect(onWorkflowStarted).toHaveBeenCalledWith(
        "started-collateral-generation",
      ),
    );
  });

  it("does not render when open is false", () => {
    render(
      <UnifiedCatalogModal
        open={false}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    expect(screen().queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape key", async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    await waitFor(() => screen().getByRole("dialog"));
    fireEvent.keyDown(screen().getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
