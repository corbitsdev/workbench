/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import {
  isRecordTerminal,
  runListIsActive,
  useArchiveWorkflowRun,
  useResumeWorkflow,
  useStartWorkflow,
  useWorkflowRecord,
  useWorkflowRuns,
  useWorkflowRunState,
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
  it("is true only for completed and failed", () => {
    expect(isRecordTerminal("completed")).toBe(true);
    expect(isRecordTerminal("failed")).toBe(true);
    expect(isRecordTerminal("running")).toBe(false);
    expect(isRecordTerminal("awaiting")).toBe(false);
  });
});

describe("runListIsActive", () => {
  it("is false for an empty or all-terminal list, true if any run still advances", () => {
    expect(runListIsActive([])).toBe(false);
    expect(
      runListIsActive([{ status: "completed" }, { status: "failed" }]),
    ).toBe(false);
    expect(
      runListIsActive([{ status: "completed" }, { status: "running" }]),
    ).toBe(true);
    expect(runListIsActive([{ status: "awaiting" }])).toBe(true);
  });
});

describe("useWorkflowRecord", () => {
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
