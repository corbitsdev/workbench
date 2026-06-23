// Proves the deterministic-tool step path (CL-2202): a step whose placeholder
// agent carries the deterministic marker tags invokes the named tool's runner
// DIRECTLY with the runtime-resolved `req.input` and returns its output — no
// agent is constructed, no inference runs. It also dispatches via the real
// `buildStepTools` runner (a local posix tool here, since the hub manifest is
// stubbed empty) and fails loud when the declared tool is not pinned.
//
// `mock.module` is process-global and leaks across this suite, so this file
// stubs ONLY `globalThis.fetch` (restored per-test) — never `./agent-tools` —
// and exercises the real tool runner the production path builds.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createIsogitStore } from "@intx/storage-isogit";

import {
  runDeterministicToolStep,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(
    tmpDirs.map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
  tmpDirs.length = 0;
});

// Empty manifest + no credentials: the step loads only its local posix tools,
// which is enough to prove the deterministic dispatch invokes the named tool's
// runner with `req.input` and returns its `ToolResult`.
function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/internal/tools/manifest")) {
      return new Response(
        JSON.stringify({
          manifest: { schemaVersion: "1", topLevel: [], entries: [] },
          tarballs: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/internal/tools/credentials")) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeEnv(): Promise<{
  env: Record<string, unknown>;
  workdir: string;
}> {
  const storeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "det-step-"),
  );
  tmpDirs.push(storeDir);
  const workdir = path.join(storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });
  const storage = await createIsogitStore(storeDir, async (p: string) => p);
  const ctx: StepToolContext = {
    hubHttpUrl: "http://hub.invalid",
    sidecarToken: "tok",
    tenantId: "ten_1",
    stepAgentId: "ins_dep-render",
    stepAddress: "ins_dep-render",
    principalId: "ins_dep-render",
    grants: [],
    cacheRoot: path.join(storeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };
  return {
    env: {
      sources: [],
      defaultSource: "",
      storage,
      workdir,
      audit: storage,
      directors: {},
      [STEP_TOOL_CONTEXT_KEY]: ctx,
    },
    workdir,
  };
}

describe("runDeterministicToolStep", () => {
  test("invokes the named tool with req.input and returns its output", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // `write_file` is a real local posix tool the step runner always loads;
    // the deterministic path must call it with `req.input` as the arguments.
    // A wrong-args call (e.g. an agent reply, or empty args) would error; a
    // successful, non-error ToolResult proves the runner received our input
    // object verbatim as the tool arguments and ran without any inference.
    const input = { path: "out.txt", content: "deck rendered" };
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input,
      signal: new AbortController().signal,
    });

    const output = result.output;
    expect(typeof output).toBe("object");
    expect(output).not.toBeNull();
    const tr = output as Record<string, unknown>;
    // A ToolResult shape (callId), not an agent reply — no inference produced it.
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("rejects a non-object, non-null input rather than guessing tool arguments", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "write_file",
        input: "not-an-object",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires an object \(or no\) input/);
  });

  test("coerces null input to empty tool arguments (no-arg tool call)", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // A step with no `input` selector resolves to null; a no-arg tool call
    // must run with {} rather than throwing. write_file will fail its own
    // arg validation, but the point is the harness does NOT reject null at
    // the argument-shape guard — it reaches the runner.
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: null,
      signal: new AbortController().signal,
    });
    expect(result.output).toBeDefined();
  });

  test("fails loud when the declared tool is not in the loaded runner", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "gamma_create_from_template",
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not in the step's loaded runner/);
  });

  test("reshapes the evaluated input into tool args via the argMap (rename + literal)", async () => {
    stubHubFetch();
    // The evaluated input names its fields `body`/`name`, NOT the tool's
    // `content`/`path`. The argMap renames `body` -> `content` and supplies
    // `path` as a literal; a non-error ToolResult proves the runner received
    // the reshaped args (write_file requires both `content` and `path`).
    const { env } = await makeEnv();
    const reshaped = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: { body: "deck rendered", name: "out.txt", ignored: "drop me" },
      argMapJson: JSON.stringify({
        content: { from: "body" },
        path: { literal: "out.txt" },
      }),
      signal: new AbortController().signal,
    });
    const tr = reshaped.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("fails loud when an argMap `from` field is absent on the evaluated input", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "write_file",
        input: { path: "out.txt" },
        argMapJson: JSON.stringify({
          content: { from: "reply" },
          path: { from: "path" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/input field "reply"/);
  });
});
