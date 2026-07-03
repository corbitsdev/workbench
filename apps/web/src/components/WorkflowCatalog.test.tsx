/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const meta = {
  version: "0.1.0",
  sha: "abc1234",
  deployedAt: "2026-06-27T00:00:00.000Z",
};

let deploymentsResult: { data: unknown[]; isPending: boolean } = {
  data: [],
  isPending: false,
};
let startShouldReject = false;
// When set, mutateAsync fires onRedeploying (simulating a deploy-window retry)
// and stays pending until `resolveStart` is called, so the transient state is
// observable.
let startShouldRedeploy = false;
let resolveStart: (() => void) | undefined;
let lastStartVars: {
  kind: string;
  input: unknown;
  onRedeploying?: () => void;
} | null = null;

mock.module("../hooks/use-workflow", () => ({
  useWorkflowDeployments: () => deploymentsResult,
  useStartWorkflow: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: (vars: {
      kind: string;
      input: unknown;
      onRedeploying?: () => void;
    }) => {
      lastStartVars = vars;
      if (startShouldReject) {
        return Promise.reject(new Error("no capacity"));
      }
      if (startShouldRedeploy) {
        vars.onRedeploying?.();
        return new Promise<{ runId: string }>((resolve) => {
          resolveStart = () => resolve({ runId: `started-${vars.kind}` });
        });
      }
      return Promise.resolve({ runId: `started-${vars.kind}` });
    },
  }),
}));

const { WorkflowCatalog } = require("./WorkflowCatalog");

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const defaultDeployments = [
  {
    deploymentId: "dep-1",
    kind: "collateral-generation",
    status: "running",
    createdAt: "",
    meta: {
      ...meta,
      label: "Pain Point Collateral Generation",
      description: "Analyze a call transcript and generate collateral.",
    },
  },
  {
    // No meta — falls back to the humanized kind.
    deploymentId: "dep-2",
    kind: "gamma-presentation-creator",
    status: "running",
    createdAt: "",
  },
];

describe("WorkflowCatalog", () => {
  let onWorkflowStarted: ReturnType<typeof mock>;

  beforeEach(() => {
    onWorkflowStarted = mock(() => undefined);
    deploymentsResult = { data: defaultDeployments, isPending: false };
    startShouldReject = false;
    startShouldRedeploy = false;
    resolveStart = undefined;
    lastStartVars = null;
  });

  afterEach(cleanup);

  it("lists every deployed kind, including never-run kinds", () => {
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={["collateral-generation"]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    screen.getByText("Pain Point Collateral Generation");
    screen.getByText("Analyze a call transcript and generate collateral.");
    screen.getByText("Gamma presentation creator");
  });

  it("groups previously-run kinds separately from never-run kinds", () => {
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={["collateral-generation"]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const recent = screen.getByRole("region", { name: "Recently run" });
    within(recent).getByText("Pain Point Collateral Generation");
    expect(within(recent).queryByText("Gamma presentation creator")).toBeNull();

    const more = screen.getByRole("region", { name: "More workflows" });
    within(more).getByText("Gamma presentation creator");
  });

  it("shows a single ungrouped list when nothing has been run yet", () => {
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const all = screen.getByRole("region", { name: "All workflows" });
    within(all).getByText("Pain Point Collateral Generation");
    within(all).getByText("Gamma presentation creator");
    expect(screen.queryByRole("region", { name: "Recently run" })).toBeNull();
  });

  it("filters entries by search across label and kind", async () => {
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/search workflows/i),
      "collateral",
    );

    screen.getByText("Pain Point Collateral Generation");
    expect(screen.queryByText("Gamma presentation creator")).toBeNull();

    await user.clear(screen.getByPlaceholderText(/search workflows/i));
    await user.type(screen.getByPlaceholderText(/search workflows/i), "zzz");
    screen.getByText("No workflows match your search.");
  });

  it("starts a run with empty input and reports the new run id", async () => {
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const card = screen
      .getByText("Gamma presentation creator")
      .closest("div[data-kind]");
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole("button"));

    await waitFor(() =>
      expect(onWorkflowStarted).toHaveBeenCalledWith(
        "started-gamma-presentation-creator",
      ),
    );
    expect(lastStartVars).toMatchObject({
      kind: "gamma-presentation-creator",
      input: {},
    });
    expect(typeof lastStartVars?.onRedeploying).toBe("function");
  });

  it("surfaces a start failure as a legible error", async () => {
    startShouldReject = true;
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const card = screen
      .getByText("Gamma presentation creator")
      .closest("div[data-kind]");
    fireEvent.click(within(card as HTMLElement).getByRole("button"));

    await waitFor(() => screen.getByText("no capacity"));
    expect(onWorkflowStarted).not.toHaveBeenCalled();
  });

  it("shows a transient redeploying state during a deploy-window retry, then clears on success", async () => {
    startShouldRedeploy = true;
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );

    const card = screen
      .getByText("Gamma presentation creator")
      .closest("div[data-kind]");
    fireEvent.click(within(card as HTMLElement).getByRole("button"));

    await waitFor(() => screen.getByText("Finishing an update — retrying…"));
    // No error flash while retrying.
    expect(screen.queryByText("no capacity")).toBeNull();

    resolveStart?.();
    await waitFor(() =>
      expect(onWorkflowStarted).toHaveBeenCalledWith(
        "started-gamma-presentation-creator",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Finishing an update — retrying…")).toBeNull(),
    );
  });

  it("shows loading and empty states", () => {
    deploymentsResult = { data: [], isPending: true };
    const first = render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );
    screen.getByText("Loading workflows…");
    first.unmount();

    deploymentsResult = { data: [], isPending: false };
    render(
      <WorkflowCatalog
        tenantId="ten-1"
        runKinds={[]}
        onWorkflowStarted={onWorkflowStarted}
      />,
      { wrapper },
    );
    screen.getByText("No workflows deployed yet.");
  });
});
