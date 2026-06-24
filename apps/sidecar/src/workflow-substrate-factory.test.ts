// Proves the sidecar's parent-step invoker runs the REAL agent harness
// (a real `agent.send`) rather than the upstream reference sidecar's
// canned stub (`{ reply: req.agent.id, turn: null }`). A stub
// `agentFactory` stands in for the reactor assembly so the test does not
// require a live inference source; the assertion is on the invoker's
// observable output (the agent's reply + turn), not on the mock.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Agent, AgentDefinition, BaseEnv } from '@intx/agent';

// The assistant turn shape, derived from Agent.send rather than imported by
// name — @intx/agent does not re-export ConversationTurn from its barrel.
type SendTurn = Awaited<ReturnType<Agent['send']>>['turn'];
import { createDefaultDirectorRegistry } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import type { GrantEvaluator } from '@intx/workflow-host';
import type { StepInvokeRequest } from '@intx/workflow';

import {
  createSidecarStepInvoker,
  createStepInferenceSourceResolver,
  createStepToolContextResolver,
} from './workflow-substrate-factory';
import type { RepoStore } from '@intx/hub-sessions';
import { STEP_TOOL_CONTEXT_KEY, type StepToolContext } from './step-tool-harness';

const tmpDirs: string[] = [];
const realFetch = globalThis.fetch;

describe('createStepInferenceSourceResolver', () => {
  const src = { provider: 'openai-compatible', model: 'm' } as InferenceSource;
  const other = { provider: 'openai-compatible', model: 'n' } as InferenceSource;

  test('resolves a directly-pinned stepId', () => {
    const resolve = createStepInferenceSourceResolver({ analyze: src });
    expect(resolve('analyze')).toEqual(src);
  });

  test('falls back a map-expanded stepId to its base step source', () => {
    // `map` fans out `generate` into `generate[0]`, `generate[1]`, … at run
    // time; those dynamic ids are not in the statically-pinned table, so they
    // must resolve to the base step's pinned source.
    const resolve = createStepInferenceSourceResolver({ generate: src });
    expect(resolve('generate[0]')).toEqual(src);
    expect(resolve('generate[12]')).toEqual(src);
  });

  test('prefers a direct pin over the base fallback', () => {
    const resolve = createStepInferenceSourceResolver({
      generate: other,
      'generate[0]': src,
    });
    expect(resolve('generate[0]')).toEqual(src);
  });

  test('throws when neither the stepId nor its base is pinned', () => {
    const resolve = createStepInferenceSourceResolver({ analyze: src });
    expect(() => resolve('generate[0]')).toThrow(/no InferenceSource pinned/);
    expect(() => resolve('missing')).toThrow(/no InferenceSource pinned/);
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

// Empty hub manifest + no credentials: the step loads only its local posix
// tools, enough to dispatch `write_file` through the deterministic branch.
function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/internal/tools/manifest')) {
      return new Response(
        JSON.stringify({
          manifest: { schemaVersion: '1', topLevel: [], entries: [] },
          tarballs: [],
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/api/internal/tools/credentials')) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-step-invoker-'));
  tmpDirs.push(dir);
  return dir;
}

const STEP_ID = 'draft';
const RUN_ID = 'run-abc';
const SOURCE: InferenceSource = {
  id: 'src-1',
  provider: 'openai-compatible',
  baseURL: 'https://example.invalid',
  apiKey: 'sk-test',
  model: 'test-model',
};

function makeAgentDefinition(id: string): AgentDefinition<BaseEnv> {
  return {
    id,
    systemPrompt: 'you are a test agent',
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
  };
}

function makeRequest(): StepInvokeRequest {
  return {
    agent: makeAgentDefinition('agent-under-test'),
    input: { topic: 'launch announcement' },
    authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
    signal: new AbortController().signal,
  };
}

const allowAll: GrantEvaluator = async () => ({
  effect: 'allow',
  matchingGrants: [],
  resolvedBy: null,
});

describe('createSidecarStepInvoker', () => {
  test("returns the real agent's reply, not the upstream stub shape", async () => {
    const dataDir = await makeDataDir();
    const REPLY = 'Here is the drafted announcement.';
    const turn = {
      role: 'assistant',
      content: REPLY,
    } as unknown as SendTurn;

    let sentContent: string | undefined;
    let closed = false;
    const stubAgent: Agent = {
      send: async (content: Parameters<Agent['send']>[0]) => {
        sentContent = typeof content === 'string' ? content : content.content;
        return { reply: REPLY, turn };
      },
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {
        closed = true;
      },
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'test-signature',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => stubAgent,
    });

    const result = await invoke(makeRequest());

    expect(result.output).toEqual({ reply: REPLY, turn });
    // Guard against regressing to the upstream stub, which echoed the
    // agent id with a null turn.
    expect(result.output).not.toEqual({
      reply: 'agent-under-test',
      turn: null,
    });
    // The step's resolved input reached the agent's send path.
    expect(sentContent).toBe(JSON.stringify({ topic: 'launch announcement' }));
    // The invoker tore the agent down on the success path.
    expect(closed).toBe(true);
  });

  test('builds a real per-step BaseEnv (storage/workdir/audit/directors) for the agent factory', async () => {
    const dataDir = await makeDataDir();
    let capturedEnv: BaseEnv | undefined;
    const stubAgent: Agent = {
      send: async () => ({
        reply: 'ok',
        turn: { role: 'assistant', content: 'ok' } as unknown as SendTurn,
      }),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    const directors = createDefaultDirectorRegistry();
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors,
      evaluateGrants: allowAll,
      agentFactory: async (_def, env) => {
        capturedEnv = env;
        return stubAgent;
      },
    });

    await invoke(makeRequest());

    expect(capturedEnv).toBeDefined();
    const env = capturedEnv as BaseEnv;
    expect(env.sources).toEqual([SOURCE]);
    expect(env.defaultSource).toBe(SOURCE.id);
    expect(env.directors).toBe(directors);
    // workdir is a real, created directory under the per-run/per-step root.
    const stat = await fs.stat(env.workdir);
    expect(stat.isDirectory()).toBe(true);
    expect(env.workdir).toContain(RUN_ID);
    expect(env.workdir).toContain(STEP_ID);
    // storage + audit are the same per-step isogit store (mirrors default-harness).
    expect(env.audit).toBe(env.storage as unknown as typeof env.audit);
  });

  test('rejects a step request missing runId before building an agent', async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error('should not reach the agent factory');
      },
    });

    const req: StepInvokeRequest = {
      agent: makeAgentDefinition('a'),
      input: {},
      authzContext: { stepId: STEP_ID, attempt: 1 },
      signal: new AbortController().signal,
    };

    await expect(invoke(req)).rejects.toThrow(/runId is required/);
    expect(factoryCalled).toBe(false);
  });

  test('routes a deterministic-tool-tagged step away from the inference agent factory', async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error('inference factory must not run for a deterministic step');
      },
    });

    const detAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition('deterministic-gamma_create_from_template'),
      tags: {
        'workbench.stepKind': 'deterministic-tool',
        'workbench.tool': 'gamma_create_from_template',
      },
    };
    const req: StepInvokeRequest = {
      agent: detAgent,
      input: { foo: 'bar' },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    // The deterministic branch builds the step env and dispatches to the tool
    // handler; with no resolveStepToolContext wired (pure-dispatch test), the
    // handler fails loud on the missing tool context. The key assertion is
    // that the INFERENCE factory was never consulted — the marker rerouted it.
    await expect(invoke(req)).rejects.toThrow(/STEP_TOOL_CONTEXT/);
    expect(factoryCalled).toBe(false);
  });

  test('an unmarked step still reaches the inference agent factory', async () => {
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const stubAgent: Agent = {
      send: async () => ({
        reply: 'ok',
        turn: { role: 'assistant', content: 'ok' } as unknown as SendTurn,
      }),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => {
        factoryCalled = true;
        return stubAgent;
      },
    });

    await invoke(makeRequest());
    expect(factoryCalled).toBe(true);
  });

  // Regression (greybeard/critique): a `map({ over, step: deterministicToolStep })`
  // dispatches each per-element invocation through the deterministic branch, not
  // inference. The runtime calls the step invoker once per element with the same
  // deterministic-tagged step request shape, so we drive `invoke` per element and
  // assert: the real tool runner ran once per element (a file written per item)
  // and the inference agent factory was never constructed.
  test('dispatches a per-element map invocation through the deterministic tool branch, never inference', async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    let factoryCalled = false;
    const resolveStepToolContext = async (req: StepInvokeRequest): Promise<StepToolContext> => {
      const stepId = req.authzContext.stepId ?? 'step';
      return {
        hubHttpUrl: 'http://hub.invalid',
        sidecarToken: 'tok',
        tenantId: 'ten_1',
        stepAgentId: `ins_dep-${stepId}`,
        stepAddress: `ins_dep-${stepId}`,
        principalId: `ins_dep-${stepId}`,
        grants: [],
        cacheRoot: path.join(dataDir, 'cache'),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      };
    };
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      resolveStepToolContext,
      agentFactory: async () => {
        factoryCalled = true;
        throw new Error('inference factory must not run for a map of det steps');
      },
    });

    const detAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition('deterministic-write_file'),
      tags: {
        'workbench.stepKind': 'deterministic-tool',
        'workbench.tool': 'write_file',
      },
    };

    // `map` invokes the step invoker once per element; each element gets a
    // distinct per-attempt store. Drive them sequentially with a per-element
    // attempt so the per-step store teardown does not race (a test-harness
    // concern, not a product one) and assert every element dispatched through
    // the deterministic tool branch.
    const elements = ['a.txt', 'b.txt', 'c.txt'];
    const outputs: { output: unknown }[] = [];
    for (let i = 0; i < elements.length; i += 1) {
      const name = elements[i] as string;
      outputs.push(
        await invoke({
          agent: detAgent,
          input: { path: name, content: `content-${name}` },
          authzContext: { stepId: STEP_ID, attempt: i + 1, runId: RUN_ID },
          signal: new AbortController().signal,
        })
      );
    }

    // No agent was constructed for any element.
    expect(factoryCalled).toBe(false);
    // The tool runner produced a ToolResult envelope per element.
    expect(outputs).toHaveLength(elements.length);
    for (const { output } of outputs) {
      const tr = output as Record<string, unknown>;
      expect(tr).toHaveProperty('callId');
      expect(tr.isError).not.toBe(true);
    }
  });

  // Inline-inference dispatch (CL-2251). An inline-tagged step is a no-tool
  // single-turn reasoning turn the hub did NOT deploy as a per-step session,
  // so the sidecar runs it with a bare createAgent against the step's pinned
  // STEP_INFERENCE_SOURCES entry — never the tool-capable factory, and the
  // step env carries NO tool context (the hub wrote none for it).
  test('runs an inline-inference-tagged step with the pinned source and no tool context', async () => {
    const dataDir = await makeDataDir();
    const INLINE_REPLY = '{"painPoints":[]}';
    const turn = { role: 'assistant', content: INLINE_REPLY } as unknown as SendTurn;

    let capturedEnv: BaseEnv | undefined;
    let capturedDef: AgentDefinition<BaseEnv> | undefined;
    let sentContent: string | undefined;
    let closed = false;
    const stubAgent: Agent = {
      send: async (content: Parameters<Agent['send']>[0]) => {
        sentContent = typeof content === 'string' ? content : content.content;
        return { reply: INLINE_REPLY, turn };
      },
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {
        closed = true;
      },
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    // No resolveStepToolContext wired — exactly the production inline path.
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async (def, env) => {
        capturedDef = def as AgentDefinition<BaseEnv>;
        capturedEnv = env;
        return stubAgent;
      },
    });

    const inlineAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition('inline-analyze'),
      systemPrompt: 'extract pain points and return JSON',
      tags: { 'workbench.stepKind': 'inline-inference' },
    };
    const req: StepInvokeRequest = {
      agent: inlineAgent,
      input: { transcript: 'they hate slow onboarding' },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    const result = await invoke(req);

    // The inline branch returned the real agent reply in the {reply,turn} shape.
    expect(result.output).toEqual({ reply: INLINE_REPLY, turn });
    // CONDITION 1: the env's inference source is the pinned STEP_INFERENCE_SOURCES
    // entry for this step — credentials come from the env table, not on-demand.
    const env = capturedEnv as BaseEnv;
    expect(env.sources).toEqual([SOURCE]);
    expect(env.defaultSource).toBe(SOURCE.id);
    // No tool context was stashed on the env: the inline path never builds a
    // tool-capable harness, so createStepAgentFactory's key is absent.
    expect((env as unknown as Record<string, unknown>)[STEP_TOOL_CONTEXT_KEY]).toBeUndefined();
    // The step's real system prompt reached the bare agent factory.
    expect(capturedDef?.systemPrompt).toBe('extract pain points and return JSON');
    // The resolved input reached the agent's send path, JSON-encoded.
    expect(sentContent).toBe(JSON.stringify({ transcript: 'they hate slow onboarding' }));
    // The inline branch tore the agent down.
    expect(closed).toBe(true);
  });

  test('resolves selected skill IDs before inline inference sends input', async () => {
    const dataDir = await makeDataDir();
    const INLINE_REPLY = 'done';
    const turn = { role: 'assistant', content: INLINE_REPLY } as unknown as SendTurn;
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        authorization:
          init?.headers instanceof Headers ? init.headers.get('authorization') : 'Bearer tok',
      });
      return new Response(
        JSON.stringify({
          skills: [
            {
              id: 'skill_hammy',
              name: 'hammy-humanizer',
              displayName: 'Hammy Humanizer',
              content: 'Make the copy sound human.',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    let sentContent: string | undefined;
    const stubAgent: Agent = {
      send: async (content: Parameters<Agent['send']>[0]) => {
        sentContent = typeof content === 'string' ? content : content.content;
        return { reply: INLINE_REPLY, turn };
      },
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    const resolveStepToolContext = async (req: StepInvokeRequest): Promise<StepToolContext> => ({
      hubHttpUrl: 'http://hub.test',
      sidecarToken: 'tok',
      tenantId: 'ten_1',
      stepAgentId: `ins_dep-${req.authzContext.stepId ?? 'step'}`,
      stepAddress: `ins_dep-${req.authzContext.stepId ?? 'step'}`,
      principalId: `ins_dep-${req.authzContext.stepId ?? 'step'}`,
      grants: [],
      cacheRoot: path.join(dataDir, 'cache'),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });
    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      resolveStepToolContext,
      agentFactory: async () => stubAgent,
    });

    await invoke({
      agent: {
        ...makeAgentDefinition('inline-with-skill'),
        tags: { 'workbench.stepKind': 'inline-inference' },
      },
      input: { input: 'Rewrite this', skillIds: ['skill_hammy'] },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    });

    expect(calls).toEqual([
      {
        url: 'http://hub.test/api/internal/workflow-skills/resolve',
        body: { tenantId: 'ten_1', runId: RUN_ID, skillIds: ['skill_hammy'] },
        authorization: 'Bearer tok',
      },
    ]);
    expect(JSON.parse(sentContent ?? '{}')).toEqual({
      input: 'Rewrite this',
      skillIds: ['skill_hammy'],
      skills: [
        {
          id: 'skill_hammy',
          name: 'hammy-humanizer',
          displayName: 'Hammy Humanizer',
          content: 'Make the copy sound human.',
        },
      ],
    });
  });

  // CL-2253: the inline branch must attach a draining stream() consumer so the
  // agent's pre-start event buffer drains instead of overflowing (the WARN
  // "no stream() consumer ever attached to drain it" on staging) and the step's
  // live progress events are observable. This stub emits events through stream()
  // and blocks the iterator open until close() fires; the assertion is that the
  // inline branch consumed every emitted event AND returned the correct reply.
  // Under the pre-CL-2253 no-drain code stream() is never called, so
  // consumedEvents stays empty and this test fails.
  test('inline-inference branch drains the agent event stream', async () => {
    const dataDir = await makeDataDir();
    const INLINE_REPLY = '{"painPoints":[]}';
    const turn = { role: 'assistant', content: INLINE_REPLY } as unknown as SendTurn;
    const emitted = [{ type: 'reactor.start' }, { type: 'inference.done' }] as const;

    const consumedEvents: unknown[] = [];
    let streamInvoked = false;
    let closed = false;
    // Gate the iterator's terminal `done` on close() so the test proves the
    // consumer drains concurrently with send() and exits cleanly on teardown
    // (a leaked, never-closing iterator would hang the invoker).
    let resolveDone: (() => void) | undefined;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const stubAgent: Agent = {
      send: async (content: Parameters<Agent['send']>[0]) => {
        void content;
        return { reply: INLINE_REPLY, turn };
      },
      stream: () => {
        streamInvoked = true;
        let index = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (index < emitted.length) {
                const value = emitted[index];
                index += 1;
                return { value, done: false };
              }
              await donePromise;
              return { value: undefined, done: true };
            },
          }),
        };
      },
      deliver: () => {},
      close: async () => {
        closed = true;
        resolveDone?.();
      },
      setSource: () => {},
      setSources: () => {},
    } as unknown as Agent;

    // Wrap stream() so the test observes exactly which events the inline branch
    // pulled off the iterator.
    const realStream = stubAgent.stream.bind(stubAgent);
    stubAgent.stream = () => {
      const it = realStream()[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const r = await it.next();
            if (!r.done) consumedEvents.push(r.value);
            return r;
          },
        }),
      };
    };

    const invoke = createSidecarStepInvoker({
      table: { [STEP_ID]: SOURCE },
      dataDir,
      signer: async () => 'sig',
      directors: createDefaultDirectorRegistry(),
      evaluateGrants: allowAll,
      agentFactory: async () => stubAgent,
    });

    const inlineAgent: AgentDefinition<BaseEnv> = {
      ...makeAgentDefinition('inline-analyze'),
      tags: { 'workbench.stepKind': 'inline-inference' },
    };
    const req: StepInvokeRequest = {
      agent: inlineAgent,
      input: { transcript: 'they hate slow onboarding' },
      authzContext: { stepId: STEP_ID, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };

    const result = await invoke(req);

    // Reply is unchanged by the drain.
    expect(result.output).toEqual({ reply: INLINE_REPLY, turn });
    // A draining consumer was attached and pulled every emitted event.
    expect(streamInvoked).toBe(true);
    expect(consumedEvents).toEqual([...emitted]);
    // The agent was torn down (which is what releases the iterator).
    expect(closed).toBe(true);
  });
});

describe('createStepToolContextResolver', () => {
  // Stub RepoStore whose `getRepoDir` points the grants read at an empty
  // temp dir; the resolver's `readStepGrants` ENOENTs and falls back to
  // deny-all, isolating the assertion to the derived step agent id.
  function makeStubBareStore(dir: string): RepoStore {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the resolver only calls getRepoDir; the rest of the RepoStore surface is unused here
    return {
      getRepoDir: () => dir,
    } as unknown as RepoStore;
  }

  function makeReq(stepId: string): StepInvokeRequest {
    return {
      agent: makeAgentDefinition('step-agent'),
      input: {},
      authzContext: { stepId, attempt: 1, runId: RUN_ID },
      signal: new AbortController().signal,
    };
  }

  test('derives stepAgentId as ins_<rawDeploymentId>-<stepId>, byte-for-byte', async () => {
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      // RAW hub deploymentId (`ses_<id>`), the value the deploy router
      // threads via WORKFLOW_RAW_DEPLOYMENT_ID.
      deploymentId: 'ses_218f6ab782774a3e70b5d86f01e602d8',
      tenantId: 'ten_1',
      hubHttpUrl: 'http://hub.invalid',
      sidecarToken: 'tok',
      cacheRoot: path.join(dataDir, 'cache'),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq('intake'));

    const expected = 'ins_ses_218f6ab782774a3e70b5d86f01e602d8-intake';
    expect(ctx.stepAgentId).toBe(expected);
    expect(ctx.stepAddress).toBe(expected);
    expect(ctx.principalId).toBe(expected);
    // The bug shapes this fix closes: no double ins_, no slugified
    // deployment address.
    expect(ctx.stepAgentId).not.toContain('ins_ins_');
    expect(ctx.stepAgentId).not.toContain('abklabs-com');
    // Missing grants file -> fail-closed deny-all.
    expect(ctx.grants).toEqual([]);
  });

  test('normalizes a map-expanded stepId to its base for the step agent id', async () => {
    const dataDir = await makeDataDir();
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      deploymentId: 'ses_218f6ab782774a3e70b5d86f01e602d8',
      tenantId: 'ten_1',
      hubHttpUrl: 'http://hub.invalid',
      sidecarToken: 'tok',
      cacheRoot: path.join(dataDir, 'cache'),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    // `map` fans `persist` into `persist[0]`; the hub only registered the step
    // agent row + grants + tool manifest under `persist`, so the resolver must
    // strip the `[i]` suffix or the mapped step's tools never load.
    const ctx = await resolve(makeReq('persist[0]'));
    expect(ctx.stepAgentId).toBe('ins_ses_218f6ab782774a3e70b5d86f01e602d8-persist');
  });

  test('a slug-shaped deploymentId would NOT have produced the registered id (documents the regression)', async () => {
    const dataDir = await makeDataDir();
    // Feeding the slugified deployment address (the pre-fix bug) yields
    // the double-prefixed, dot-slugged id the hub never registered.
    const resolve = createStepToolContextResolver({
      bareStore: makeStubBareStore(dataDir),
      deploymentId: 'ins_ses_abc-abklabs-com',
      tenantId: 'ten_1',
      hubHttpUrl: 'http://hub.invalid',
      sidecarToken: 'tok',
      cacheRoot: path.join(dataDir, 'cache'),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    });

    const ctx = await resolve(makeReq('intake'));

    expect(ctx.stepAgentId).toBe('ins_ins_ses_abc-abklabs-com-intake');
    expect(ctx.stepAgentId).not.toBe('ins_ses_abc-intake');
  });
});
