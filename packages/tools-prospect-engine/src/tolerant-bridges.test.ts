import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUB_RPC_ENV_KEY } from "@workbench/tool-credentials";
import {
  emptyProspectEngineLedger,
  parseProspectEngineLedger,
} from "@workbench/shared";
import {
  prospectEngineLedgerBridge,
  prospectEngineMailBridge,
} from "./tolerant-bridges";

const HUB_RPC_ENV = {
  [HUB_RPC_ENV_KEY]: {
    baseURL: "https://hub.example.test",
    token: "tok",
    tenantId: "tenant_1",
    agentId: "agent_1",
    principalId: "principal_1",
    sessionId: "",
  },
};

describe("prospectEngineLedgerBridge", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("skips artifact_read entirely when findLedger returned no artifact (cold start)", async () => {
    const runner = prospectEngineLedgerBridge(HUB_RPC_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_ledger_tolerant",
        arguments: {},
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ skipped: true });
  });

  test("a hub-RPC failure degrades to a successful outer ToolResult with an error envelope, never throwing or setting isError", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const runner = prospectEngineLedgerBridge(HUB_RPC_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_ledger_tolerant",
        arguments: { content: JSON.stringify({ artifactId: "art_1" }) },
      },
      new AbortController().signal,
    );
    // The load-bearing assertion: the OUTER envelope must never be isError,
    // or `runDeterministicToolStep` throws unconditionally on the action
    // dispatch path (`step-tool-harness.ts`).
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("network down"),
    });
  });

  test("a degraded readLedger result still parses to an empty ledger downstream (parseLedger's real fallback)", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const runner = prospectEngineLedgerBridge(HUB_RPC_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_ledger_tolerant",
        arguments: { content: JSON.stringify({ artifactId: "art_1" }) },
      },
      new AbortController().signal,
    );
    // parseLedger's own handler reads `content` from the merged step output;
    // the bridge's error-envelope content has no `content`/`body`/`text`
    // field, so parseProspectEngineLedger falls back to empty exactly like
    // a cold-start night.
    const ledger = parseProspectEngineLedger(result.content);
    expect(ledger.accounts).toEqual(emptyProspectEngineLedger().accounts);
    expect(ledger.creditLog).toEqual(emptyProspectEngineLedger().creditLog);
    expect(ledger.version).toBe(emptyProspectEngineLedger().version);
  });

  test("a successful hub-RPC call forwards artifact_read's structured content unchanged", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result: "ok",
            isError: false,
            structuredResult: { body: "{}", title: "ledger" },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    const runner = prospectEngineLedgerBridge(HUB_RPC_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_ledger_tolerant",
        arguments: { content: JSON.stringify({ artifactId: "art_1" }) },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ body: "{}", title: "ledger" });
  });
});

describe("prospectEngineMailBridge", () => {
  test("no transport configured degrades to a successful envelope with an error, never throwing", async () => {
    const runner = prospectEngineMailBridge({} as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_send_mail_tolerant",
        arguments: { userAddress: "a@test.com", title: "hi", text: "body" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("no mail transport"),
    });
  });
});
