// CL-2503 goal-A regression: the fatal deterministic-step path must log WITH the
// Error object, because that `error` field is what the workflow-child's Sentry
// sink turns into a captureException (full stack), not just the one-line message
// the on-disk StepFailed event preserves. Drop the field and Sentry silently
// goes back to no-stack with a green suite — so this spies the @intx/log error
// channel and asserts (a) a real fatal failure logs an Error instance, and (b)
// the cancellation path (aborted signal) logs nothing, so a teardown never pages.
//
// mock.module is process-global; this file mocks @intx/log and must run under
// `bun test --isolate`. The mock is registered before the harness is imported.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createIsogitStore } from "@workbench/storage-isogit";

interface LoggedError {
  message: string;
  fields: Record<string, unknown> | undefined;
}
const errorCalls: LoggedError[] = [];
const spyLogger = {
  error: (message: string, fields?: Record<string, unknown>) => {
    errorCalls.push({ message, fields });
  },
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
};
mock.module("@intx/log", () => ({
  getLogger: () => spyLogger,
}));

const { runDeterministicToolStep, STEP_TOOL_CONTEXT_KEY } = await import(
  "./step-tool-harness"
);

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];

beforeEach(() => {
  errorCalls.length = 0;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(
    tmpDirs.map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
  tmpDirs.length = 0;
});

function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/internal/tools/credentials")) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeEnv(): Promise<Record<string, unknown>> {
  const storeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "det-step-log-"),
  );
  tmpDirs.push(storeDir);
  const workdir = path.join(storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });
  const storage = await createIsogitStore(storeDir, async (p: string) => p);
  return {
    sources: [],
    defaultSource: "",
    storage,
    workdir,
    audit: storage,
    directors: {},
    // Stub transport so mail_send is registered; the failure under test is the
    // harness shape guard (non-object input), not tool availability.
    transport: {
      send: async () => ({ messageId: "m1" }),
    },
    [STEP_TOOL_CONTEXT_KEY]: {
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      tenantId: "ten_1",
      stepAgentId: "ins_dep-render",
      stepAddress: "ins_dep-render",
      principalId: "ins_dep-render",
      grants: [],
      // No deploy/ subtree under storeDir → empty on-disk manifest → no package
      // tools. Mail loads via the transport stub above.
      deployTreeDir: storeDir,
      cacheRoot: path.join(storeDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    },
  };
}

const FAILED_MSG = "Deterministic step tool {tool} failed for {address}";

describe("deterministic step failure logging (Sentry capture seam)", () => {
  test("a real fatal failure logs at error level WITH an Error object", async () => {
    stubHubFetch();
    const env = await makeEnv();
    // A non-object input is a real (non-cancellation) step failure on the fatal
    // path: it must log with the Error so captureException gets the stack.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: "not-an-object",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires an object/);

    const failureLog = errorCalls.find((c) => c.message === FAILED_MSG);
    expect(failureLog).toBeTruthy();
    expect(failureLog?.fields?.error).toBeInstanceOf(Error);
    expect(failureLog?.fields?.tool).toBe("mail_send");
  });

  test("a cancelled step (aborted signal) does NOT log the failure — no paging on teardown", async () => {
    stubHubFetch();
    const env = await makeEnv();
    const controller = new AbortController();
    controller.abort();
    // An aborted signal exercises the cancellation guard: the throw is the
    // cancellation, rethrown, but it must NOT be logged at error level (a
    // run being torn down is not a fault to page on).
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: "not-an-object",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/requires an object/);

    expect(errorCalls.find((c) => c.message === FAILED_MSG)).toBeUndefined();
  });
});
