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
        meta: {
          version: "0.1.0",
          sha: "abc1234",
          deployedAt: "2026-06-27T00:00:00.000Z",
          label: "Pain Point Collateral Generation",
          description: "Analyze a call transcript and generate collateral.",
        },
      },
      {
        // No meta — the card falls back to the humanized kind, no description.
        deploymentId: "dep-2",
        kind: "gamma-presentation-creator",
        status: "running",
        createdAt: "",
      },
      {
        deploymentId: "dep-3",
        kind: "seo-enrichment",
        status: "running",
        createdAt: "",
        meta: {
          version: "0.1.0",
          sha: "abc1234",
          deployedAt: "2026-06-27T00:00:00.000Z",
          label: "SEO Enrichment Report",
        },
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

    // Cards use the deploy-meta label + description; a deployment with no meta
    // falls back to the humanized kind and shows no description.
    await waitFor(() => screen().getByText("Pain Point Collateral Generation"));
    screen().getByText("Analyze a call transcript and generate collateral.");
    screen().getByText("SEO Enrichment Report");
    screen().getByText("Gamma presentation creator");

    expect(screen().queryByRole("button", { name: "Agents" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Workflows" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("collapses the workflow grid to a single column at mobile widths", async () => {
    render(
      <UnifiedCatalogModal
        open={true}
        tenantId="tenant-1"
        onClose={onClose}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const card = await waitFor(() =>
      screen().getByText("Pain Point Collateral Generation"),
    );
    // The card grid stacks to one column on phones (grid-cols-1) and only
    // splits to two columns at the sm breakpoint, so it never overflows 375px.
    const grid = card.closest("div.grid");
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain("grid-cols-1");
    expect(grid!.className).toContain("sm:grid-cols-2");
    expect(grid!.className).not.toMatch(/(^|\s)grid-cols-2(\s|$)/);
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

    await waitFor(() => screen().getByText("Pain Point Collateral Generation"));

    const user = userEvent.setup();
    const searchInput = screen().getByPlaceholderText(/search/i);
    await user.type(searchInput, "collateral");

    screen().getByText("Pain Point Collateral Generation");
    await waitFor(() =>
      expect(screen().queryByText("Presentation generation")).toBeNull(),
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

    await waitFor(() => screen().getByText("Pain Point Collateral Generation"));

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
