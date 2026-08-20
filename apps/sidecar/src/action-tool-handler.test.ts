// Unit tests for the workbench-native action-handler registry
// (`createActionToolHandlerRegistry`). Exercises the seam directly: a
// fake `materialize` stands in for `materializeStepTools` (which reads a
// real deploy tree off disk -- out of scope for a unit test), and
// `createEffectContext` (the same helper `@intx/workflow-host`'s
// `createWorkflowActionInvoker` uses in production) builds the
// capability- and ledger-checked context each bound handler runs
// against.
import { describe, expect, test } from "bun:test";

import { createEffectContext } from "@intx/workflow";
import type { EffectLedger, WorkflowAuthorizeFn } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow/definition";
import { defineTool, type BaseEnv, type ToolBundle } from "@intx/agent";
import { toolConsumer, type GrantRule } from "@intx/authz";
import {
  createCredentialProviderRegistry,
  createHttpCredentialProvider,
} from "@intx/harness";
import type { CredentialDelivery } from "@intx/types/sidecar";
import type { CredentialWiring } from "@intx/workflow-host";

import {
  createActionToolHandlerRegistry,
  type ActionStepMaterializationArgs,
  type MaterializeStepTools,
} from "./action-tool-handler";
import type { StepToolCacheConfig } from "./step-agent-tools";

const CACHE: StepToolCacheConfig = {
  cacheMaxBytes: 1024,
  registryMaxTarballBytes: 1024,
};

function materializationArgs(
  stepId: string,
  credentials?: ActionStepMaterializationArgs["credentials"],
): ActionStepMaterializationArgs {
  return {
    dataDir: "/tmp/action-tool-handler-test",
    mailboxAddress: `${stepId}@run.test`,
    stepId,
    stepCount: 1,
    storeDir: "/tmp/action-tool-handler-test/store",
    cache: CACHE,
    registries: new Map(),
    ...(credentials !== undefined ? { credentials } : {}),
  };
}

function definitionWithOneAction(handler: string): WorkflowDefinition {
  return {
    id: "wf-test",
    triggers: [],
    steps: {
      s1: { id: "s1", kind: "action", handler },
    },
    stepOrder: ["s1"],
  };
}

const allowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

function inMemoryLedger(): EffectLedger {
  const store = new Map<string, { output: unknown }>();
  return {
    async lookup(effectKey) {
      return store.get(effectKey);
    },
    async record(effectKey, output) {
      store.set(effectKey, { output });
    },
  };
}

function runViaEffectContext(
  handler: (
    input: unknown,
    ctx: never,
    signal: AbortSignal,
  ) => Promise<unknown>,
  input: unknown,
  requires: readonly string[],
): Promise<unknown> {
  const ctx = createEffectContext({
    authorize: allowAll,
    effects: inMemoryLedger(),
    requires,
    authzContext: { runId: "r1", stepId: "s1" },
    input,
  });
  return handler(input, ctx as never, new AbortController().signal);
}

/** A one-tool factory that echoes its call arguments back as JSON, with no
 * credential requirement. */
function echoFactory(toolName: string, id = "@test/echo-tools/echo") {
  return defineTool({
    id,
    definitions: [{ name: toolName }],
    factory: (): ToolBundle => ({
      definitions: [{ name: toolName, description: "echo", inputSchema: {} }],
      run: async (call) => ({
        callId: call.id,
        content: JSON.stringify(call.arguments),
      }),
    }),
  });
}

describe("createActionToolHandlerRegistry", () => {
  test("dispatches a materialized tool through the resolved handler", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [echoFactory("echo_tool")],
      pluginFactories: [],
    });
    const resolve = await createActionToolHandlerRegistry({
      definition: definitionWithOneAction("echo_tool"),
      materializationByStepId: new Map([["s1", materializationArgs("s1")]]),
      providers: createCredentialProviderRegistry([]),
      materialize,
    });

    const handler = resolve("echo_tool");
    const output = await runViaEffectContext(handler, { n: 3 }, ["echo_tool"]);
    expect(output).toEqual(JSON.stringify({ n: 3 }));
  });

  test("unknown ref throws", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [echoFactory("echo_tool")],
      pluginFactories: [],
    });
    const resolve = await createActionToolHandlerRegistry({
      definition: definitionWithOneAction("echo_tool"),
      materializationByStepId: new Map([["s1", materializationArgs("s1")]]),
      providers: createCredentialProviderRegistry([]),
      materialize,
    });

    expect(() => resolve("missing_tool")).toThrow(
      /no action step in the workflow definition declares this handler ref/,
    );
  });

  test("missing materialization args for a declared action step fails closed at construction", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [],
      pluginFactories: [],
    });
    await expect(
      createActionToolHandlerRegistry({
        definition: definitionWithOneAction("echo_tool"),
        materializationByStepId: new Map(),
        providers: createCredentialProviderRegistry([]),
        materialize,
      }),
    ).rejects.toThrow(/no materialization args were supplied/);
  });

  test("a handler ref with no matching materialized tool definition fails closed at construction", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [echoFactory("some_other_tool")],
      pluginFactories: [],
    });
    await expect(
      createActionToolHandlerRegistry({
        definition: definitionWithOneAction("echo_tool"),
        materializationByStepId: new Map([["s1", materializationArgs("s1")]]),
        providers: createCredentialProviderRegistry([]),
        materialize,
      }),
    ).rejects.toThrow(/no materialized tool package/);
  });

  test("ctx.perform: undeclared capability fails closed", async () => {
    const materialize: MaterializeStepTools = async () => ({
      factories: [echoFactory("echo_tool")],
      pluginFactories: [],
    });
    const resolve = await createActionToolHandlerRegistry({
      definition: definitionWithOneAction("echo_tool"),
      materializationByStepId: new Map([["s1", materializationArgs("s1")]]),
      providers: createCredentialProviderRegistry([]),
      materialize,
    });
    const handler = resolve("echo_tool");
    await expect(
      runViaEffectContext(handler, { n: 1 }, ["other.cap"]),
    ).rejects.toThrow(/not in its declared requires set/);
  });

  test("a tool result with isError throws", async () => {
    const toolName = "failing_tool";
    const materialize: MaterializeStepTools = async () => ({
      factories: [
        defineTool({
          id: "@test/echo-tools/failing",
          definitions: [{ name: toolName }],
          factory: (): ToolBundle => ({
            definitions: [
              { name: toolName, description: "fails", inputSchema: {} },
            ],
            run: async (call) => ({
              callId: call.id,
              content: "boom",
              isError: true,
            }),
          }),
        }),
      ],
      pluginFactories: [],
    });
    const resolve = await createActionToolHandlerRegistry({
      definition: definitionWithOneAction(toolName),
      materializationByStepId: new Map([["s1", materializationArgs("s1")]]),
      providers: createCredentialProviderRegistry([]),
      materialize,
    });
    const handler = resolve(toolName);
    await expect(runViaEffectContext(handler, {}, [toolName])).rejects.toThrow(
      /returned an error result/,
    );
  });

  test("a factory requiring credentials receives the consumer-scoped capability", async () => {
    const toolName = "credentialed_tool";
    const consumer = toolConsumer("@test/cred-tools");
    let sawCredentials: unknown;
    const materialize: MaterializeStepTools = async () => ({
      factories: [
        defineTool({
          id: "@test/cred-tools/credentialed",
          requires: ["credentials"],
          definitions: [{ name: toolName }],
          factory: (env: BaseEnv & { credentials?: unknown }): ToolBundle => {
            sawCredentials = env.credentials;
            return {
              definitions: [
                {
                  name: toolName,
                  description: "needs creds",
                  inputSchema: {},
                },
              ],
              run: async (call) => ({ callId: call.id, content: "ok" }),
            };
          },
        }),
      ],
      pluginFactories: [],
    });

    const delivery: CredentialDelivery = {
      bindings: [{ handle: "svc", credentialId: "cred_1", consumer }],
      materials: [
        {
          credentialId: "cred_1",
          providerKey: "http",
          origin: "https://api.test",
          secret: "s3cr3t",
        },
      ],
    };
    const grant: GrantRule = {
      id: "grant_1",
      resource: "credential:cred_1",
      action: "use",
      effect: "allow",
      origin: "system",
      conditions: { tool: consumer },
      expiresAt: null,
      roleId: null,
      principalId: null,
    };
    const wiring: CredentialWiring = {
      materialRef: { current: delivery },
      resolveStepGrants: () => [grant],
    };

    const resolve = await createActionToolHandlerRegistry({
      definition: definitionWithOneAction(toolName),
      materializationByStepId: new Map([
        ["s1", materializationArgs("s1", { wiring })],
      ]),
      providers: createCredentialProviderRegistry([
        createHttpCredentialProvider({
          fetch: async () => new Response("{}", { status: 200 }),
        }),
      ]),
      materialize,
    });

    const handler = resolve(toolName);
    await runViaEffectContext(handler, {}, [toolName]);
    expect(sawCredentials).toBeDefined();
  });
});
