/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { logger } from "../lib/logger";
import type { RunRecord } from "../lib/run-state-adapter";
import {
  CONVERSATION_RUN_IDLE_POLL_MS,
  CONVERSATION_RUN_POLL_MS,
  conversationRunPollInterval,
  isRecordTerminal,
  runListIsActive,
  useConversationWorkflowRuns,
  useArchiveWorkflowRun,
  useStopWorkflowRun,
  useResumeWorkflow,
  useStartWorkflow,
  useWorkflowRecord,
  useWorkflowRuns,
  useWorkflowRunState,
  useWorkflowStepOutputs,
} from "./use-workflow";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

const runningRecord = {
  runId: "wfr_1",
  kind: "pain-point-collateral",
  status: "running",
};

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("isRecordTerminal", () => {
  it("is true for completed, failed, and stopped", () => {
    expect(isRecordTerminal("completed")).toBe(true);
    expect(isRecordTerminal("failed")).toBe(true);
    expect(isRecordTerminal("stopped")).toBe(true);
    expect(isRecordTerminal("running")).toBe(false);
    expect(isRecordTerminal("awaiting")).toBe(false);
    expect(isRecordTerminal("provisioning")).toBe(false);
  });
});

describe("runListIsActive", () => {
  it("is false for an empty or all-terminal list, true if any run still advances", () => {
    expect(runListIsActive([])).toBe(false);
    expect(
      runListIsActive([{ status: "completed" }, { status: "failed" }]),
    ).toBe(false);
    expect(runListIsActive([{ status: "stopped" }])).toBe(false);
    expect(
      runListIsActive([{ status: "completed" }, { status: "running" }]),
    ).toBe(true);
    expect(runListIsActive([{ status: "awaiting" }])).toBe(true);
  });
});

describe("conversationRunPollInterval", () => {
  it("backs off to the idle tick when the list is empty or fully terminal", () => {
    expect(conversationRunPollInterval([])).toBe(CONVERSATION_RUN_IDLE_POLL_MS);
    expect(
      conversationRunPollInterval([
        { status: "completed" },
        { status: "failed" },
      ]),
    ).toBe(CONVERSATION_RUN_IDLE_POLL_MS);
    expect(conversationRunPollInterval([{ status: "stopped" }])).toBe(
      CONVERSATION_RUN_IDLE_POLL_MS,
    );
  });

  it("keeps the 5s cadence while any run is non-terminal, and before first data", () => {
    expect(conversationRunPollInterval(undefined)).toBe(
      CONVERSATION_RUN_POLL_MS,
    );
    expect(
      conversationRunPollInterval([
        { status: "completed" },
        { status: "running" },
      ]),
    ).toBe(CONVERSATION_RUN_POLL_MS);
    expect(conversationRunPollInterval([{ status: "awaiting" }])).toBe(
      CONVERSATION_RUN_POLL_MS,
    );
  });
});

describe("useConversationWorkflowRuns", () => {
  // conversationId == Myra thread id; producers stamp the same id as
  // originConversationId — the hook filters by exactly that id.
  it("filters records by the conversation (Myra thread) id and parses the rows", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(
        jsonResponse(200, [
          {
            runId: "wfr_1",
            kind: "pain-point-collateral",
            status: "running",
            createdAt: "now",
            originConversationId: "thread-1",
          },
        ]),
      );
    }) as typeof fetch;

    const { result } = renderHook(
      () => useConversationWorkflowRuns("thread-1", "tn-x"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain("originConversationId=thread-1");
    expect(requested).toContain("tenantId=tn-x");
    expect(result.current.data?.[0]?.runId).toBe("wfr_1");
  });

  it("is disabled without a conversation id", () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, []));
    }) as typeof fetch;

    const { result } = renderHook(() => useConversationWorkflowRuns(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(called).toBe(false);
  });
});

describe("useWorkflowRecord", () => {
  it("carries the owner attribution the trace page renders", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        jsonResponse(200, {
          runId: "wfr_1",
          kind: "brief",
          status: "completed",
          principalId: "prn_owner",
          ownerDisplayName: "Ada Lovelace",
        }),
      )) as typeof fetch;

    const client = new QueryClient();
    const { result } = renderHook(() => useWorkflowRecord("wfr_1"), {
      wrapper: recordWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const record: RunRecord | undefined = result.current.data;
    expect(record?.principalId).toBe("prn_owner");
    expect(record?.ownerDisplayName).toBe("Ada Lovelace");
  });

  it("does not retry a forbidden record and surfaces the error after one fetch", async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      return Promise.resolve(jsonResponse(403, { error: "Forbidden" }));
    }) as typeof fetch;

    const client = new QueryClient();
    const { result } = renderHook(() => useWorkflowRecord("wfr_1"), {
      wrapper: recordWrapper(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(1);
  });

  it("is disabled when runId is null", () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, runningRecord));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRecord(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(called).toBe(false);
  });

  it("reads and parses the record from the records endpoint", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, runningRecord));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRecord("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain("/workflow-exec/records/wfr_1");
    expect(requested).toContain("tenantId=tn-x");
    expect(result.current.data?.status).toBe("running");
    expect(result.current.data?.kind).toBe("pain-point-collateral");
  });

  it("surfaces an error for a malformed record shape", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        jsonResponse(200, { runId: "x", status: "bogus" }),
      )) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRecord("wfr_1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useWorkflowRunState", () => {
  const logRunState = {
    runId: "wfr_1",
    phase: "running",
    lastSeq: 3,
    steps: [
      {
        stepId: "intake",
        phase: "completed",
        stepType: "human",
        currentAttempt: 1,
      },
      {
        stepId: "review",
        phase: "awaiting-signal",
        stepType: "human",
        currentAttempt: 1,
        awaitingSignalName: "approve",
      },
    ],
  };

  it("is disabled when runId is null", () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, logRunState));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRunState(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(called).toBe(false);
  });

  it("reads and parses the log-derived state from the runs/:id/state endpoint", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, logRunState));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain("/workflow-exec/runs/wfr_1/state");
    expect(requested).toContain("tenantId=tn-x");
    expect(result.current.data?.steps[1]?.phase).toBe("awaiting-signal");
    expect(result.current.data?.steps[1]?.awaitingSignalName).toBe("approve");
  });

  it("surfaces an error for a malformed log-state shape", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        jsonResponse(200, { runId: "x", phase: "bogus", steps: [] }),
      )) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRunState("wfr_1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("does not fetch /state while a co-located record is provisioning with no deploymentId yet", async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      return Promise.resolve(jsonResponse(200, logRunState));
    }) as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["workflow-record", "wfr_1", "tn-x"], {
      runId: "wfr_1",
      kind: "pain-point-collateral",
      status: "provisioning",
    });

    const { result } = renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: recordWrapper(client),
    });

    // Give any (wrongly) fired queryFn a tick to resolve before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isError).toBe(false);
    expect(calls).toBe(0);
  });

  it("fetches /state once the co-located record's deploymentId appears", async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      return Promise.resolve(jsonResponse(200, logRunState));
    }) as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["workflow-record", "wfr_1", "tn-x"], {
      runId: "wfr_1",
      kind: "pain-point-collateral",
      status: "running",
      deploymentId: "dep_abc",
    });

    const { result } = renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: recordWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toBe(1);
  });

  it("warns when mounted without a co-located useWorkflowRecord for the same key", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, logRunState))) as typeof fetch;
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

    renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });

    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("no co-mounted useWorkflowRecord"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("does not warn when a co-located useWorkflowRecord query is registered for the same key", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, logRunState))) as typeof fetch;
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Registers the query entry (loading, no data yet) without seeding a
    // record — this is the "record query mounted, still resolving" case,
    // distinct from "no record query at all".
    void client.prefetchQuery({
      queryKey: ["workflow-record", "wfr_1", "tn-x"],
      queryFn: () => new Promise(() => undefined),
    });

    renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: recordWrapper(client),
    });

    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("no co-mounted useWorkflowRecord"),
      ),
    ).toBe(false);
    warnSpy.mockRestore();
  });
});

describe("useWorkflowStepOutputs", () => {
  // Per-run deployments (CL-2582) key each run to its own ses_ deployment; the
  // legacy /workflow-runs/:deploymentId/steps lookup 404s for them (CL-2704).
  // Outputs must resolve from the run-keyed log-derived /state fold instead.
  const stateWithOutputs = {
    runId: "wfr_run1",
    phase: "running",
    lastSeq: 5,
    steps: [
      {
        stepId: "analyze",
        phase: "completed",
        stepType: "inline",
        currentAttempt: 1,
        outputRef: `inline:${JSON.stringify({ reply: "analysis" })}`,
      },
      {
        stepId: "huge",
        phase: "completed",
        stepType: "agent",
        currentAttempt: 1,
        outputRef: "blob:" + "b".repeat(64),
      },
      {
        stepId: "review",
        phase: "awaiting-signal",
        stepType: "human",
        currentAttempt: 1,
        awaitingSignalName: "approve",
      },
    ],
  };

  it("resolves outputs run-keyed from /state and never calls the legacy deployment-keyed endpoint", async () => {
    const requested: string[] = [];
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested.push(String(url));
      return Promise.resolve(jsonResponse(200, stateWithOutputs));
    }) as typeof fetch;

    const { result } = renderHook(
      () => useWorkflowStepOutputs("wfr_run1", "tn-x"),
      { wrapper: wrapper() },
    );
    await waitFor(() =>
      expect(result.current.data).toEqual({ analyze: { reply: "analysis" } }),
    );
    expect(
      requested.some((u) => u.includes("/workflow-exec/runs/wfr_run1/state")),
    ).toBe(true);
    // The deployment-keyed legacy path must be gone entirely (CL-2704).
    expect(requested.some((u) => u.includes("/workflow-runs/"))).toBe(false);
  });

  it("shares the run-state cache entry instead of issuing a second request", async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      return Promise.resolve(jsonResponse(200, stateWithOutputs));
    }) as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => ({
        state: useWorkflowRunState("wfr_run1", "tn-x"),
        outputs: useWorkflowStepOutputs("wfr_run1", "tn-x"),
      }),
      { wrapper: recordWrapper(client) },
    );
    await waitFor(() =>
      expect(result.current.outputs.data).toEqual({
        analyze: { reply: "analysis" },
      }),
    );
    expect(result.current.state.data?.runId).toBe("wfr_run1");
    expect(calls).toBe(1);
  });

  it("is disabled when runId is null", () => {
    let called = false;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      called = true;
      return Promise.resolve(jsonResponse(200, stateWithOutputs));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowStepOutputs(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(called).toBe(false);
  });
});

describe("useStartWorkflow", () => {
  it("POSTs to the start endpoint and returns the parsed run record", async () => {
    let requested = "";
    let method = "";
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requested = String(url);
      method = init?.method ?? "GET";
      return Promise.resolve(jsonResponse(200, { ...runningRecord }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStartWorkflow("tn-x"), {
      wrapper: wrapper(),
    });
    const record = await result.current.mutateAsync({
      kind: "pain-point-collateral",
      input: {},
    });
    expect(method).toBe("POST");
    expect(requested).toContain("/workflow-exec/pain-point-collateral/start");
    expect(requested).toContain("tenantId=tn-x");
    expect(record.runId).toBe("wfr_1");
  });

  it("rejects when the start response is malformed", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(200, { nope: true }))) as typeof fetch;

    const { result } = renderHook(() => useStartWorkflow(), {
      wrapper: wrapper(),
    });
    await expect(
      result.current.mutateAsync({ kind: "pain-point-collateral", input: {} }),
    ).rejects.toThrow(/run-record response/);
  });

  it("auto-retries a deploy-window 503, fires onRedeploying, then resolves (CL-2707)", async () => {
    let calls = 0;
    // Retry-After: 0 keeps the backoff at 0ms so the retry loop runs fast.
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "deploy_in_progress", message: "updating" },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            },
          ),
        );
      }
      return Promise.resolve(jsonResponse(200, { ...runningRecord }));
    }) as typeof fetch;

    let redeployNotices = 0;
    const { result } = renderHook(() => useStartWorkflow("tn-x"), {
      wrapper: wrapper(),
    });
    const record = await result.current.mutateAsync({
      kind: "pain-point-collateral",
      input: {},
      onRedeploying: () => (redeployNotices += 1),
    });
    expect(record.runId).toBe("wfr_1");
    expect(calls).toBe(2);
    expect(redeployNotices).toBe(1);
  });

  it("does not retry a normal failure and surfaces its message", async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      calls += 1;
      return Promise.resolve(jsonResponse(500, { error: "no capacity" }));
    }) as typeof fetch;

    const { result } = renderHook(() => useStartWorkflow("tn-x"), {
      wrapper: wrapper(),
    });
    await expect(
      result.current.mutateAsync({ kind: "pain-point-collateral", input: {} }),
    ).rejects.toThrow("no capacity");
    expect(calls).toBe(1);
  });
});

function recordWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe("useResumeWorkflow", () => {
  it("POSTs the signal to the resume endpoint and returns the next record", async () => {
    let requested = "";
    let sentBody: unknown = null;
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requested = String(url);
      sentBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(
        jsonResponse(200, {
          ...runningRecord,
          status: "awaiting",
        }),
      );
    }) as typeof fetch;

    const { result } = renderHook(() => useResumeWorkflow("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });
    const next = await result.current.mutateAsync({
      signalName: "context",
      payload: { context: "hi" },
    });
    expect(requested).toContain("/workflow-exec/records/wfr_1/resume");
    expect(sentBody).toEqual({
      signalName: "context",
      payload: { context: "hi" },
    });
    expect(next.status).toBe("awaiting");
  });

  it("optimistically flips the cached record from awaiting to running on mutate", async () => {
    const awaitingRecord = {
      runId: "wfr_1",
      kind: "pain-point-collateral",
      status: "awaiting" as const,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["workflow-record", "wfr_1", "tn-x"], awaitingRecord);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      await gate;
      return jsonResponse(200, {
        ...awaitingRecord,
        status: "running",
      });
    }) as typeof fetch;

    const { result } = renderHook(() => useResumeWorkflow("wfr_1", "tn-x"), {
      wrapper: recordWrapper(client),
    });

    const pending = result.current.mutateAsync({
      signalName: "context",
      payload: {},
    });

    // Before the POST resolves, onMutate must have flipped status to running in the
    // cache while keeping the gate's currentStepId so the panel stays on the screen.
    await waitFor(() => {
      const cached = client.getQueryData([
        "workflow-record",
        "wfr_1",
        "tn-x",
      ]) as {
        status: string;
      };
      expect(cached.status).toBe("running");
    });

    release();
    await pending;
  });

  it("rolls the cached record back to the awaiting snapshot when the resume fails", async () => {
    const awaitingRecord = {
      runId: "wfr_1",
      kind: "pain-point-collateral",
      status: "awaiting" as const,
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["workflow-record", "wfr_1", "tn-x"], awaitingRecord);

    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(500, { error: "boom" }))) as typeof fetch;

    const { result } = renderHook(() => useResumeWorkflow("wfr_1", "tn-x"), {
      wrapper: recordWrapper(client),
    });

    await expect(
      result.current.mutateAsync({ signalName: "context", payload: {} }),
    ).rejects.toThrow();

    const cached = client.getQueryData([
      "workflow-record",
      "wfr_1",
      "tn-x",
    ]) as { status: string };
    expect(cached.status).toBe("awaiting");
  });
});

describe("useArchiveWorkflowRun", () => {
  it("POSTs to the archive endpoint and invalidates the run list", async () => {
    let requested = "";
    let method = "";
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requested = String(url);
      method = init?.method ?? "GET";
      return Promise.resolve(jsonResponse(200, { archived: true }));
    }) as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let invalidatedKey: readonly unknown[] | undefined;
    client.invalidateQueries = ((filters?: {
      queryKey?: readonly unknown[];
    }) => {
      invalidatedKey = filters?.queryKey;
      return Promise.resolve();
    }) as typeof client.invalidateQueries;

    const { result } = renderHook(() => useArchiveWorkflowRun("tn-x"), {
      wrapper: recordWrapper(client),
    });
    await result.current.mutateAsync("wfr_1");

    expect(method).toBe("POST");
    expect(requested).toContain("/workflow-exec/records/wfr_1/archive");
    expect(requested).toContain("tenantId=tn-x");
    expect(invalidatedKey).toEqual(["workflow-runs"]);
  });

  it("rejects when the archive request fails", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        jsonResponse(403, { error: "Forbidden" }),
      )) as typeof fetch;

    const { result } = renderHook(() => useArchiveWorkflowRun(), {
      wrapper: wrapper(),
    });
    await expect(result.current.mutateAsync("wfr_1")).rejects.toThrow();
  });
});

describe("useStopWorkflowRun", () => {
  it("POSTs to the stop endpoint and invalidates live-run queries", async () => {
    let requested = "";
    let method = "";
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requested = String(url);
      method = init?.method ?? "GET";
      return Promise.resolve(jsonResponse(200, { stopped: true }));
    }) as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidatedKeys: unknown[][] = [];
    client.invalidateQueries = ((filters?: {
      queryKey?: readonly unknown[];
    }) => {
      if (filters?.queryKey) invalidatedKeys.push([...filters.queryKey]);
      return Promise.resolve();
    }) as typeof client.invalidateQueries;

    const { result } = renderHook(() => useStopWorkflowRun("tn-x"), {
      wrapper: recordWrapper(client),
    });
    await result.current.mutateAsync("wfr_1");

    expect(method).toBe("POST");
    expect(requested).toContain("/workflow-exec/records/wfr_1/stop");
    expect(requested).toContain("tenantId=tn-x");
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ["workflow-runs"],
        ["conversation-workflow-runs"],
        ["workflow-record", "wfr_1", "tn-x"],
        ["workflow-run-state", "wfr_1", "tn-x"],
      ]),
    );
  });

  it("rejects when the stop request fails", async () => {
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(
        jsonResponse(403, { error: "Forbidden" }),
      )) as typeof fetch;

    const { result } = renderHook(() => useStopWorkflowRun(), {
      wrapper: wrapper(),
    });
    await expect(result.current.mutateAsync("wfr_1")).rejects.toThrow();
  });
});

describe("useWorkflowRuns", () => {
  it("lists records and parses the row shape", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(
        jsonResponse(200, [
          {
            runId: "wfr_1",
            kind: "pain-point-collateral",
            status: "running",
            createdAt: "now",
          },
        ]),
      );
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRuns("tn-wb"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toContain("/workflow-exec/records");
    expect(requested).toContain("tenantId=tn-wb");
    expect(result.current.data?.[0]?.runId).toBe("wfr_1");
  });

  it("omits tenantId when no workbench is active", async () => {
    let requested = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
      requested = String(url);
      return Promise.resolve(jsonResponse(200, []));
    }) as typeof fetch;

    const { result } = renderHook(() => useWorkflowRuns(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).not.toContain("tenantId=");
  });
});
