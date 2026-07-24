import { afterEach, describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { TOOL_ERROR_RECOVERY_GUIDANCE } from "@workbench/shared";
import { HUB_RPC_ENV_KEY, getHubRpc } from "./index";
import { defineHubBackedToolPackage } from "./factory";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = {
  baseURL: "https://hub.test",
  token: "sidecar-tok",
  tenantId: "t1",
  agentId: "a1",
  principalId: "p1",
  sessionId: "s1",
};

const definitions: ToolDefinition[] = [
  {
    name: "artifact_create",
    description: "create",
    inputSchema: { type: "object", properties: {} },
  },
];

function envWith(extra: Record<string, unknown> = {}): BaseEnv {
  return { [HUB_RPC_ENV_KEY]: ctx, ...extra } as unknown as BaseEnv;
}

describe("getHubRpc", () => {
  test("returns the injected context", () => {
    expect(getHubRpc({ [HUB_RPC_ENV_KEY]: ctx })).toEqual(ctx);
  });
  test("throws when absent", () => {
    expect(() => getHubRpc({})).toThrow(/hub-RPC/);
  });
});

describe("defineHubBackedToolPackage", () => {
  test("declares the hub-RPC requirement and exposes its definitions", () => {
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    expect(factory.requires).toEqual([HUB_RPC_ENV_KEY]);
    expect(factory(envWith()).definitions.map((d) => d.name)).toEqual([
      "artifact_create",
    ]);
  });

  test("forwards a call to the scoped hub endpoint with the agent identity", async () => {
    let captured: { url: string; body: unknown; auth: unknown } | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = {
        url: String(input),
        body: JSON.parse(init?.body as string),
        auth: (init?.headers as Record<string, string>).Authorization,
      };
      return new Response(JSON.stringify({ result: "ok", isError: false }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const bundle = factory(envWith());
    const result = await bundle.run(
      { id: "c1", name: "artifact_create", arguments: { title: "x" } },
      AbortSignal.timeout(1000),
    );

    expect(captured?.url).toBe("https://hub.test/api/internal/hub-tools/run");
    expect(captured?.auth).toBe("Bearer sidecar-tok");
    expect(captured?.body).toMatchObject({
      tenantId: "t1",
      agentId: "a1",
      principalId: "p1",
      sessionId: "s1",
      toolName: "artifact_create",
      args: { title: "x" },
    });
    expect(result).toMatchObject({ content: "ok", isError: false });
  });

  test("surfaces a non-ok hub response as isError", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const result = await factory(envWith()).run(
      { id: "c1", name: "artifact_create", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.isError).toBe(true);
  });

  test("throws at construction when the hub-RPC context is absent", () => {
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    expect(() => factory({} as BaseEnv)).toThrow(/hub-RPC/);
  });

  test("appends the recovery guidance to a hub-reported tool error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ result: "boom: invalid args", isError: true }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const result = await factory(envWith()).run(
      { id: "c1", name: "artifact_create", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(TOOL_ERROR_RECOVERY_GUIDANCE);
  });

  test("does not append the recovery guidance to a successful result", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: "ok", isError: false }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const result = await factory(envWith()).run(
      { id: "c1", name: "artifact_create", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).not.toContain(TOOL_ERROR_RECOVERY_GUIDANCE);
  });

  test("appends the guidance exactly once even when it already flowed through a wrapping seam", async () => {
    const alreadyGuided = `boom: invalid args\n\n${TOOL_ERROR_RECOVERY_GUIDANCE}`;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: alreadyGuided, isError: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const result = await factory(envWith()).run(
      { id: "c1", name: "artifact_create", arguments: {} },
      AbortSignal.timeout(1000),
    );
    const occurrences =
      String(result.content).split(TOOL_ERROR_RECOVERY_GUIDANCE).length - 1;
    expect(occurrences).toBe(1);
  });

  test("appends the guidance exactly once on a non-ok hub response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const factory = defineHubBackedToolPackage({
      id: "@workbench/tools-artifact/artifact",
      definitions,
    });
    const result = await factory(envWith()).run(
      { id: "c1", name: "artifact_create", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.isError).toBe(true);
    const occurrences =
      String(result.content).split(TOOL_ERROR_RECOVERY_GUIDANCE).length - 1;
    expect(occurrences).toBe(1);
  });
});
