// Proves `runDeterministicToolStep`'s core dispatch mechanics: given a tool
// name and evaluated input, it invokes the named tool's runner DIRECTLY —
// no agent is constructed, no inference runs — and returns its output. This
// is the shared primitive both the (retired) `deterministic-tool` step class
// used and the native `action` primitive still uses today
// (`action-tool-handler.ts`). It also dispatches via the real
// `buildStepTools` runner (mail_send when a transport is injected, since the
// hub/deploy tree is stubbed empty and free local POSIX is no longer auto-
// injected) and fails loud when the declared tool is not pinned. The
// `argMap` reshape path this file used to also cover is deleted along with
// `deterministicToolStep`/`reshapeWithArgMap` — no caller passes an argMap
// anymore.
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
});
