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
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { createInMemoryTransport } from "@intx/mail-memory";
import { createIsogitStore } from "@workbench/storage-isogit";

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

// Empty deploy tree + no credentials: the step loads only its local posix
// tools, which is enough to prove the deterministic dispatch invokes the named
// tool's runner with `req.input` and returns its `ToolResult`. Only the
// credential rail is still a hub fetch.
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

async function makeEnv(opts?: {
  transport?: ReturnType<typeof createInMemoryTransport>;
}): Promise<{
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
    // No deploy/ subtree under storeDir → empty on-disk manifest → local tools
    // only (posix/mail), which is what the deterministic dispatch exercises.
    deployTreeDir: storeDir,
    cacheRoot: path.join(storeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };
  const env: Record<string, unknown> = {
    sources: [],
    defaultSource: "",
    storage,
    workdir,
    audit: storage,
    directors: {},
    [STEP_TOOL_CONTEXT_KEY]: ctx,
  };
  if (opts?.transport !== undefined) {
    env.transport = opts.transport;
  }
  return { env, workdir };
}

async function mailSendUnregisteredSenderFixture(): Promise<{
  env: Record<string, unknown>;
  recipient: string;
  mailInput: { to: string; content: string; subject: string };
}> {
  const transport = createInMemoryTransport();
  const recipientKey = await generateKeyPair();
  const recipient = "usr_member@tenant.example";
  transport.register(recipient, createEd25519Crypto(recipientKey));
  const senderAddress = "ins_ses_deploy@tenant.example";
  const { env } = await makeEnv({ transport });
  const ctx = env[STEP_TOOL_CONTEXT_KEY] as StepToolContext;
  ctx.stepAddress = senderAddress;
  ctx.stepAgentId = senderAddress;
  ctx.principalId = senderAddress;
  const mailInput = {
    to: recipient,
    content: "brief body",
    subject: "Your morning brief",
  };
  return { env, recipient, mailInput };
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
    // must run with {} rather than throwing at the harness shape guard.
    // write_file then returns isError for missing path, which fails the step.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "write_file",
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/required argument "path"/);
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
    ).rejects.toThrow(/is not registered\/available for this deployment/);
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

  test("nonFatal: a throwing step degrades to an isError envelope instead of rejecting", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // A non-object input throws in `verbatimToolArguments` (a real step failure).
    // Without nonFatal it rejects (asserted above); with nonFatal the harness
    // must swallow the throw and return a completed isError envelope so the run
    // is not failed by one best-effort source. The original reason is preserved
    // in `content` so the brief can record it in skippedSources with the why.
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: "not-an-object",
      nonFatal: true,
      signal: new AbortController().signal,
    });
    const output = result.output as Record<string, unknown>;
    expect(output.isError).toBe(true);
    expect(typeof output.content).toBe("string");
    expect(output.content as string).toContain("write_file");
    expect(output.content as string).toContain("requires an object");
  });

  test("nonFatal does NOT mask cancellation: an aborted signal rethrows instead of degrading", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // Run cancel/timeout aborts the step's signal. The throw is the
    // cancellation, not a source failure — degrading it to a completed
    // isError step would let the run march on past the cancel. The harness
    // must rethrow even when nonFatal is set.
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "write_file",
        input: "not-an-object",
        nonFatal: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/requires an object/);
  });

  test("nonFatal degrade also covers an unpinned tool (misconfiguration is logged + skipped, not fatal)", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "gamma_create_from_template",
      input: {},
      nonFatal: true,
      signal: new AbortController().signal,
    });
    const output = result.output as Record<string, unknown>;
    expect(output.isError).toBe(true);
    expect(output.content as string).toContain(
      "is not registered/available for this deployment",
    );
  });

  test("mail_send delivers through the substrate-injected transport", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // The workflow substrate injects an in-process transport on the step env
    // (env.transport) whenever the deployment has a mailbox. The deterministic
    // path must expose the mail runner off that transport — the real
    // @intx/tools-mail handlers and the outbound guard run; only the network
    // send is faked here.
    const sent: unknown[] = [];
    env.transport = {
      send: async (outbound: unknown) => {
        sent.push(outbound);
        return { messageId: "m1" };
      },
    };
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", content: "hi" },
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr.isError).not.toBe(true);
    expect(tr.content).toEqual({ messageId: "m1" });
    expect(sent).toEqual([
      {
        to: "usr_x@tenant.example",
        content: "hi",
        type: "conversation.message",
      },
    ]);
  });

  test("mail_send isError envelope fails the step so notify cannot complete green on send_failed", async () => {
    stubHubFetch();
    const { env, mailInput } = await mailSendUnregisteredSenderFixture();

    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: mailInput,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/send_failed/);
  });

  test("nonFatal: mail_send isError envelope degrades to completed output", async () => {
    stubHubFetch();
    const { env, mailInput } = await mailSendUnregisteredSenderFixture();

    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: mailInput,
      nonFatal: true,
      signal: new AbortController().signal,
    });
    const output = result.output as Record<string, unknown>;
    expect(output.isError).toBe(true);
    const content = output.content as Record<string, unknown>;
    expect(content.error).toMatch(/send_failed/);
  });

  test("mail_send stays unavailable when no transport is injected", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    // Pure-inference / mailbox-less deployments inject no transport; the mail
    // runner must not appear, so the declared tool fails loud as unpinned.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: { to: "usr_x@tenant.example", content: "hi" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
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

  test("a non-optional argMap field that is an empty string on the input passes through verbatim", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: { path: "out.txt", reply: "" },
      argMapJson: JSON.stringify({
        content: { from: "reply" },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("an optional argMap field absent from the input skips the tool call without throwing", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: { path: "out.txt" },
      argMapJson: JSON.stringify({
        content: { from: "reply", optional: true },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("an optional argMap field that is an empty string on the input also skips", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: { path: "out.txt", reply: "" },
      argMapJson: JSON.stringify({
        content: { from: "reply", optional: true },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("an optional argMap field present with a real value is used, not skipped", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: { path: "out.txt", reply: "real content" },
      argMapJson: JSON.stringify({
        content: { from: "reply", optional: true },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a fromJson argMap field reads a field out of a JSON-string envelope field", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: {
        path: "out.txt",
        content: JSON.stringify({
          gammaUrl: "https://x",
          exportUrl: "",
        }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "gammaUrl" },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a non-optional fromJson field missing on the parsed envelope throws", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "write_file",
        input: {
          path: "out.txt",
          content: JSON.stringify({ exportUrl: "" }),
        },
        argMapJson: JSON.stringify({
          content: { fromJson: "content", field: "gammaUrl" },
          path: { from: "path" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/JSON field "gammaUrl" of input field "content"/);
  });

  test("an optional fromJson field absent from the parsed envelope skips without throwing", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: {
        path: "out.txt",
        content: JSON.stringify({ gammaUrl: "https://x" }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "exportUrl", optional: true },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("an optional fromJson field that is an empty string in the parsed envelope also skips", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: {
        path: "out.txt",
        content: JSON.stringify({ gammaUrl: "https://x", exportUrl: "" }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "exportUrl", optional: true },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("a non-optional fromJson field present as an empty string passes through verbatim", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: {
        path: "out.txt",
        content: JSON.stringify({ gammaUrl: "https://x", exportUrl: "" }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "exportUrl" },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a fromJson envelope field that is already an object (not a JSON string) still resolves the field", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "write_file",
      input: {
        path: "out.txt",
        content: { gammaUrl: "https://x", exportUrl: "" },
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "gammaUrl" },
        path: { from: "path" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });
});
