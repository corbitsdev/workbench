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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowCatalog } from "@workbench/shared";

let catalogResult: {
  data: WorkflowCatalog | undefined;
  isPending: boolean;
  isError: boolean;
} = { data: undefined, isPending: false, isError: false };

let lastToggle: { kind: string; nextFavorite: boolean } | null = null;

let startShouldReject = false;
let startShouldRedeploy = false;
let resolveStart: (() => void) | undefined;
let lastStartVars: {
  kind: string;
  input: unknown;
  onRedeploying?: () => void;
} | null = null;

mock.module("../hooks/use-workflows-catalog", () => ({
  useWorkflowsCatalog: () => catalogResult,
  useToggleWorkflowFavorite: () => ({
    isPending: false,
    mutateAsync: (vars: { kind: string; nextFavorite: boolean }) => {
      lastToggle = vars;
      return Promise.resolve({});
    },
  }),
}));

mock.module("../hooks/use-workflow", () => ({
  useStartWorkflow: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: (vars: {
      kind: string;
      input: unknown;
      onRedeploying?: () => void;
    }) => {
      lastStartVars = vars;
      if (startShouldReject) return Promise.reject(new Error("no capacity"));
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

const {
  WorkflowCatalog: WorkflowCatalogComponent,
} = require("./WorkflowCatalog");

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const catalog: WorkflowCatalog = {
  entries: [
    {
      kind: "pain",
      label: "Pain Point Collateral",
      description: "Analyze a call transcript and generate collateral.",
      isFavorite: true,
      stepCount: 2,
      pauseCount: 1,
      steps: [
        { id: "s1", title: "Load Transcript", kind: "auto" },
        { id: "s2", title: "Approve Draft", kind: "human" },
      ],
    },
    {
      kind: "gamma",
      label: "Gamma Presentation Creator",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [{ id: "a", title: "Ingest Content", kind: "auto" }],
    },
  ],
};

function renderCatalog(onWorkflowStarted: (runId: string) => void) {
  render(
    <WorkflowCatalogComponent
      tenantId="ten-1"
      onWorkflowStarted={onWorkflowStarted}
    />,
    { wrapper },
  );
}

describe("WorkflowCatalog", () => {
  let onWorkflowStarted: ReturnType<typeof mock>;

  beforeEach(() => {
    onWorkflowStarted = mock(() => undefined);
    catalogResult = { data: catalog, isPending: false, isError: false };
    lastToggle = null;
    startShouldReject = false;
    startShouldRedeploy = false;
    resolveStart = undefined;
    lastStartVars = null;
  });

  afterEach(cleanup);

  it("pins favorites in their own group and lists the rest", () => {
    renderCatalog(onWorkflowStarted);
    screen.getByText("Favorites");
    screen.getByText("All workflows");
    // The favorited workflow exposes an unfavorite control; the other a favorite
    // control — proving the pinned grouping and per-row star state.
    expect(
      screen.getByRole("button", { name: /unfavorite pain point/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^favorite gamma presentation/i }),
    ).toBeTruthy();
  });

  it("previews the first workflow's classified steps by default", () => {
    renderCatalog(onWorkflowStarted);
    screen.getByText("Load Transcript");
    const humanStep = screen.getByText("Approve Draft").closest("li");
    expect(humanStep).not.toBeNull();
    within(humanStep!).getByText("Your input");
    screen.getByText("Pauses 1 time for you");
  });

  it("switches the preview when another workflow is selected", () => {
    renderCatalog(onWorkflowStarted);
    fireEvent.click(screen.getByText("Gamma Presentation Creator"));
    screen.getByText("Ingest Content");
    expect(screen.queryByText("Load Transcript")).toBeNull();
  });

  it("toggles a favorite with the workflow kind and next state", () => {
    renderCatalog(onWorkflowStarted);
    fireEvent.click(
      screen.getByRole("button", { name: /favorite gamma presentation/i }),
    );
    expect(lastToggle).toEqual({ kind: "gamma", nextFavorite: true });
  });

  it("starts the selected workflow and reports the new run id", async () => {
    renderCatalog(onWorkflowStarted);
    fireEvent.click(screen.getByText("Gamma Presentation Creator"));
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() =>
      expect(onWorkflowStarted).toHaveBeenCalledWith("started-gamma"),
    );
    expect(lastStartVars).toMatchObject({ kind: "gamma", input: {} });
  });

  it("surfaces a start failure as a legible error", async () => {
    startShouldReject = true;
    renderCatalog(onWorkflowStarted);
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() => screen.getByText("no capacity"));
    expect(onWorkflowStarted).not.toHaveBeenCalled();
  });

  it("shows a redeploying banner during a deploy-window retry", () => {
    startShouldRedeploy = true;
    renderCatalog(onWorkflowStarted);
    fireEvent.click(screen.getByRole("button", { name: /start run/i }));
    // onRedeploying fires synchronously inside the click, so the banner is
    // present without waiting, and no error flashes while the retry is pending.
    screen.getByText("Finishing an update — retrying…");
    expect(screen.queryByText("no capacity")).toBeNull();
    resolveStart?.();
  });

  it("shows loading, error, and empty states", () => {
    catalogResult = { data: undefined, isPending: true, isError: false };
    const loading = render(
      <WorkflowCatalogComponent tenantId="ten-1" onWorkflowStarted={mock()} />,
      { wrapper },
    );
    screen.getByText("Loading workflows…");
    loading.unmount();

    catalogResult = { data: undefined, isPending: false, isError: true };
    const errored = render(
      <WorkflowCatalogComponent tenantId="ten-1" onWorkflowStarted={mock()} />,
      { wrapper },
    );
    screen.getByText(/couldn.t load the workflow catalog/i);
    errored.unmount();

    catalogResult = {
      data: { entries: [] },
      isPending: false,
      isError: false,
    };
    render(
      <WorkflowCatalogComponent tenantId="ten-1" onWorkflowStarted={mock()} />,
      { wrapper },
    );
    screen.getByText(/No workflows are available to run in this workbench/);
  });
});
