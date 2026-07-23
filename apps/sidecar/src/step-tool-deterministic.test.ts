// Proves the deterministic-tool step path (CL-2202): a step whose placeholder
// agent carries the deterministic marker tags invokes the named tool's runner
// DIRECTLY with the runtime-resolved `req.input` and returns its output — no
// agent is constructed, no inference runs. It also dispatches via the real
// `buildStepTools` runner (mail_send when a transport is injected, since the
// hub/deploy tree is stubbed empty and free local POSIX is no longer auto-
// injected) and fails loud when the declared tool is not pinned.
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
  reshapeWithArgMap,
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

// Empty deploy tree + no credentials: no package pins. Local mail tools load
// only when a transport is present on the step env — enough to prove the
// deterministic dispatch invokes the named tool's runner with `req.input` and
// returns its `ToolResult`. Only the credential rail is still a hub fetch.
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

/** Stub transport that succeeds every send — enough for mail_send to resolve. */
function successTransport(): { send: () => Promise<{ messageId: string }> } {
  return {
    send: async () => ({ messageId: "m1" }),
  };
}

async function makeEnv(opts?: {
  transport?: ReturnType<typeof createInMemoryTransport> | { send: unknown };
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
    // No deploy/ subtree under storeDir → empty on-disk manifest → no package
    // tools. Mail loads only when opts.transport (or a later assignment) is set.
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

/** Env with a success-stub transport so mail_send is registered and runnable. */
async function makeMailEnv(): Promise<{
  env: Record<string, unknown>;
  workdir: string;
}> {
  return makeEnv({ transport: successTransport() });
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
    const { env } = await makeMailEnv();
    // `mail_send` is the real local tool the step runner loads when a transport
    // is present; the deterministic path must call it with `req.input` as the
    // arguments. A wrong-args call would error; a successful, non-error
    // ToolResult proves the runner received our input object verbatim as the
    // tool arguments and ran without any inference.
    const input = { to: "usr_x@tenant.example", content: "deck rendered" };
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
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
    const { env } = await makeMailEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: "not-an-object",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires an object \(or no\) input/);
  });

  test("coerces null input to empty tool arguments (no-arg tool call)", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // A step with no `input` selector resolves to null; a no-arg tool call
    // must run with {} rather than throwing at the harness shape guard.
    // mail_send then returns isError for missing `to`, which fails the step.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/to/);
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
    // The evaluated input names its fields `body`/`recipient`, NOT the tool's
    // `content`/`to`. The argMap renames `body` -> `content` and supplies
    // `to` as a literal; a non-error ToolResult proves the runner received
    // the reshaped args (mail_send requires both `to` and `content`).
    const { env } = await makeMailEnv();
    const reshaped = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        body: "deck rendered",
        recipient: "usr_x@tenant.example",
        ignored: "drop me",
      },
      argMapJson: JSON.stringify({
        content: { from: "body" },
        to: { literal: "usr_x@tenant.example" },
      }),
      signal: new AbortController().signal,
    });
    const tr = reshaped.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("nonFatal: a throwing step degrades to an isError envelope instead of rejecting", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // A non-object input throws in `verbatimToolArguments` (a real step failure).
    // Without nonFatal it rejects (asserted above); with nonFatal the harness
    // must swallow the throw and return a completed isError envelope so the run
    // is not failed by one best-effort source. The original reason is preserved
    // in `content` so the brief can record it in skippedSources with the why.
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: "not-an-object",
      nonFatal: true,
      signal: new AbortController().signal,
    });
    const output = result.output as Record<string, unknown>;
    expect(output.isError).toBe(true);
    expect(typeof output.content).toBe("string");
    expect(output.content as string).toContain("mail_send");
    expect(output.content as string).toContain("requires an object");
    // A degraded non-fatal step must be distinguishable from a clean
    // completion at the run level (CL-4196).
    expect(output.degraded).toBe(true);
  });

  test("nonFatal does NOT mask cancellation: an aborted signal rethrows instead of degrading", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // Run cancel/timeout aborts the step's signal. The throw is the
    // cancellation, not a source failure — degrading it to a completed
    // isError step would let the run march on past the cancel. The harness
    // must rethrow even when nonFatal is set.
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: "not-an-object",
        nonFatal: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/requires an object/);
  });

  // CL-4196: an unpinned tool is a tool-infrastructure fault (the tool was
  // never pinned/loaded at all), not a genuine tool-execution failure —
  // `nonFatal` must NOT absorb it, or the run reports COMPLETED while never
  // having attempted the step's actual work.
  test("nonFatal does NOT degrade an unpinned tool: it rethrows StepToolNotRegisteredError", async () => {
    stubHubFetch();
    const { env } = await makeEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "gamma_create_from_template",
        input: {},
        nonFatal: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
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
    // A degraded non-fatal step must be distinguishable from a clean
    // completion at the run level (CL-4196).
    expect(output.degraded).toBe(true);
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
    const { env } = await makeMailEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: { to: "usr_x@tenant.example" },
        argMapJson: JSON.stringify({
          content: { from: "reply" },
          to: { from: "to" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/input field "reply"/);
  });

  test("a non-optional argMap field that is an empty string on the input passes through verbatim", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", reply: "" },
      argMapJson: JSON.stringify({
        content: { from: "reply" },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("an optional argMap field absent from the input is OMITTED, not a step skip: the tool is still called", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // `to` is optional in this argMap, but mail_send's own runtime arg schema
    // REQUIRES `to` (@intx/tools-mail `SendArgs`), so omitting it still calls
    // the tool (no `skipped: true`) and the tool's own validation rejects the
    // call — proving the harness omitted the argument and dispatched for
    // real rather than silently skipping the step.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: { content: "deck rendered" },
        argMapJson: JSON.stringify({
          to: { from: "recipient", optional: true },
          content: { from: "content" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  test("an optional argMap field that is an empty string on the input is also omitted, not skipped", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: { recipient: "", content: "deck rendered" },
        argMapJson: JSON.stringify({
          to: { from: "recipient", optional: true },
          content: { from: "content" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  test("an optional argMap field present with a real value is used", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", reply: "real content" },
      argMapJson: JSON.stringify({
        content: { from: "reply", optional: true },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("an absent optional argMap field that maps to a genuinely optional tool argument is omitted and the tool completes normally with real output", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // `subject` is genuinely optional on mail_send (only `to`/`content` are
    // required). Omitting it from the reshaped arguments must still invoke
    // mail_send and complete the step normally — proving `optional: true`
    // means "omit this argument", not "skip the whole tool call".
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", content: "deck rendered" },
      argMapJson: JSON.stringify({
        to: { from: "to" },
        content: { from: "content" },
        subject: { from: "subject", optional: true },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a skipStepIfAbsent argMap field absent from the input skips the tool call without throwing", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example" },
      argMapJson: JSON.stringify({
        content: { from: "reply", skipStepIfAbsent: true },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("a skipStepIfAbsent argMap field that is an empty string on the input also skips", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", reply: "" },
      argMapJson: JSON.stringify({
        content: { from: "reply", skipStepIfAbsent: true },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("a skipStepIfAbsent argMap field present with a real value is used, not skipped", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: { to: "usr_x@tenant.example", reply: "real content" },
      argMapJson: JSON.stringify({
        content: { from: "reply", skipStepIfAbsent: true },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a fromJson argMap field reads a field out of a JSON-string envelope field", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: JSON.stringify({
          gammaUrl: "https://x",
          exportUrl: "",
        }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "gammaUrl" },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a non-optional fromJson field missing on the parsed envelope throws", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: {
          to: "usr_x@tenant.example",
          content: JSON.stringify({ exportUrl: "" }),
        },
        argMapJson: JSON.stringify({
          content: { fromJson: "content", field: "gammaUrl" },
          to: { from: "to" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/JSON field "gammaUrl" of input field "content"/);
  });

  test("an optional fromJson field absent from the parsed envelope is omitted, not a step skip: the tool is still called", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    // `to` (mail_send's required recipient) is mapped optional here via
    // fromJson, so an absent envelope field is omitted rather than skipping
    // the step — the tool call still runs and mail_send's own required-`to`
    // validation fails it, proving the harness dispatched for real.
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: {
          content: "deck rendered",
          meta: JSON.stringify({ gammaUrl: "https://x" }),
        },
        argMapJson: JSON.stringify({
          to: {
            fromJson: "meta",
            field: "recipient",
            optional: true,
          },
          content: { from: "content" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  test("an optional fromJson field that is an empty string in the parsed envelope is also omitted, not skipped", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    await expect(
      runDeterministicToolStep({
        env: env as never,
        toolName: "mail_send",
        input: {
          content: "deck rendered",
          meta: JSON.stringify({ gammaUrl: "https://x", recipient: "" }),
        },
        argMapJson: JSON.stringify({
          to: {
            fromJson: "meta",
            field: "recipient",
            optional: true,
          },
          content: { from: "content" },
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  test("an absent optional fromJson field that maps to a genuinely optional tool argument is omitted and the tool completes normally with real output", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: "deck rendered",
        meta: JSON.stringify({ gammaUrl: "https://x" }),
      },
      argMapJson: JSON.stringify({
        to: { from: "to" },
        content: { from: "content" },
        subject: { fromJson: "meta", field: "subject", optional: true },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a skipStepIfAbsent fromJson field absent from the parsed envelope skips without throwing", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: JSON.stringify({ gammaUrl: "https://x" }),
      },
      argMapJson: JSON.stringify({
        content: {
          fromJson: "content",
          field: "exportUrl",
          skipStepIfAbsent: true,
        },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("a skipStepIfAbsent fromJson field that is an empty string in the parsed envelope also skips", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: JSON.stringify({ gammaUrl: "https://x", exportUrl: "" }),
      },
      argMapJson: JSON.stringify({
        content: {
          fromJson: "content",
          field: "exportUrl",
          skipStepIfAbsent: true,
        },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    expect(result.output).toEqual({ skipped: true });
  });

  test("a non-optional fromJson field present as an empty string passes through verbatim", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: JSON.stringify({ gammaUrl: "https://x", exportUrl: "" }),
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "exportUrl" },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });

  test("a fromJson envelope field that is already an object (not a JSON string) still resolves the field", async () => {
    stubHubFetch();
    const { env } = await makeMailEnv();
    const result = await runDeterministicToolStep({
      env: env as never,
      toolName: "mail_send",
      input: {
        to: "usr_x@tenant.example",
        content: { gammaUrl: "https://x", exportUrl: "" },
      },
      argMapJson: JSON.stringify({
        content: { fromJson: "content", field: "gammaUrl" },
        to: { from: "to" },
      }),
      signal: new AbortController().signal,
    });
    const tr = result.output as Record<string, unknown>;
    expect(tr).toHaveProperty("callId");
    expect(tr.isError).not.toBe(true);
  });
});

// Nested `object` argMap fields (e.g. gtm-scripts-briefs' `data: { object: {
// audience, objective, ... } }`) hit the same optional/skipStepIfAbsent
// contract as top-level fields. Exercised directly against
// `reshapeWithArgMap` (a pure function) rather than through a real tool
// runner, since no tool available to this suite's stubbed deploy tree takes
// a nested object argument.
describe("reshapeWithArgMap (nested object fields)", () => {
  test("an absent optional nested field is omitted from the object argument, and the step is NOT skipped", () => {
    const result = reshapeWithArgMap(
      "write_artifact",
      { topic: "AI agents", days: 30 },
      JSON.stringify({
        title: { from: "topic" },
        data: {
          object: {
            topic: { from: "topic" },
            days: { from: "days" },
            audience: { from: "audience", optional: true },
            objective: { from: "objective", optional: true },
          },
        },
      }),
    );
    if (result.skip) {
      throw new Error(
        `expected the whole step NOT to skip; got skip: ${result.reason}`,
      );
    }
    expect(result.toolArguments).toEqual({
      title: "AI agents",
      data: { topic: "AI agents", days: 30 },
    });
  });

  test("a present optional nested field is included in the object argument", () => {
    const result = reshapeWithArgMap(
      "write_artifact",
      { topic: "AI agents", days: 30, audience: "founders" },
      JSON.stringify({
        title: { from: "topic" },
        data: {
          object: {
            topic: { from: "topic" },
            audience: { from: "audience", optional: true },
          },
        },
      }),
    );
    if (result.skip) throw new Error("expected no skip");
    expect(result.toolArguments).toEqual({
      title: "AI agents",
      data: { topic: "AI agents", audience: "founders" },
    });
  });

  test("a nested skipStepIfAbsent field absent from the input skips the whole step", () => {
    const result = reshapeWithArgMap(
      "artifact_read",
      {},
      JSON.stringify({
        wrapper: {
          object: {
            artifactId: { from: "artifactId", skipStepIfAbsent: true },
          },
        },
      }),
    );
    expect(result).toEqual({
      skip: true,
      reason:
        'object field "artifactId" is absent or empty and skipStepIfAbsent is set',
    });
  });

  test("a nested non-optional field absent from the input throws, naming the field", () => {
    expect(() =>
      reshapeWithArgMap(
        "write_artifact",
        { topic: "AI agents" },
        JSON.stringify({
          data: {
            object: { topic: { from: "topic" }, days: { from: "days" } },
          },
        }),
      ),
    ).toThrow(/object field "days" from input field "days"/);
  });

  test("a nested optional fromJson field absent on the parsed envelope is omitted, not a step skip", () => {
    const result = reshapeWithArgMap(
      "write_artifact",
      { meta: JSON.stringify({ gammaUrl: "https://x" }) },
      JSON.stringify({
        data: {
          object: {
            pdfUrl: { fromJson: "meta", field: "exportUrl", optional: true },
          },
        },
      }),
    );
    if (result.skip) throw new Error("expected no skip");
    expect(result.toolArguments).toEqual({ data: {} });
  });
});
