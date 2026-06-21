import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveDeploymentAddress, type CapabilityWalkResult } from '@intx/workflow-deploy';
import type { WorkflowDefinition } from '@intx/workflow';
import type { HarnessConfig, InferenceSource } from '@intx/types/runtime';
import type { DirectorRegistry } from '@intx/agent';
import type { AgentRepoStore, SessionService, SidecarRouter } from '@intx/hub-sessions';
import type { HubDb } from '../db';
import { evaluateGrants } from '@intx/authz';
import type { GrantRule } from '@intx/authz';
import {
  buildStepGrantRules,
  buildSupervisorDeployFrame,
  collectGrants,
  createWorkflowDeployService,
  createWorkflowRepoWriter,
  readWorkflowDefinition,
  toLaunchSession,
  toSendMultiStepDeploy,
  writeDeploymentAgentRow,
  writeDeploymentInstanceRow,
  writeStepAgentRows,
  writeStepGrantFiles,
  writeStepInstanceRows,
} from './workflow-deploy';

describe('createWorkflowRepoWriter', () => {
  test('writes the definition tree on refs/heads/main as the hub principal', async () => {
    const writeTree = mock(
      async (
        _principal: { kind: string },
        _repoId: { kind: string; id: string },
        _ref: string,
        _content: { files: Record<string, string> }
      ) => ({ commitSha: 'sha' })
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    await createWorkflowRepoWriter(repoStore).writeWorkflowRepo({
      workflowRepoId: 'wf',
      files: new Map([
        ['workflow.json', '{}'],
        ['.gitignore', ''],
      ]),
    });

    const call = writeTree.mock.calls.at(0);
    if (!call) throw new Error('writeTree was not called');
    const [principal, repoId, ref, content] = call;
    expect(principal).toEqual({ kind: 'hub' });
    expect(repoId).toEqual({ kind: 'workflow', id: 'wf' });
    expect(ref).toBe('refs/heads/main');
    expect(content.files).toEqual({ 'workflow.json': '{}', '.gitignore': '' });
  });
});

describe('toLaunchSession', () => {
  test('drops toolPackageManifest but carries systemPrompt, assetMounts, and pins', async () => {
    const launchSession = mock(async (_params: unknown) => undefined);
    const sessionService = { launchSession } as unknown as SessionService;
    const assetMounts = new Map([['skill', 'mounts/skill']]);

    await toLaunchSession(sessionService)({
      agentAddress: 'a@local',
      agentId: 'a',
      instanceId: 'i',
      config: {} as HarnessConfig,
      deployContent: {
        systemPrompt: 'p',
        assetMounts,
        toolPackageManifest: { dropped: true },
      },
      toolPackagePins: [{ name: 'pkg', version: '1.0.0' }],
    });

    expect(launchSession).toHaveBeenCalledWith({
      agentAddress: 'a@local',
      agentId: 'a',
      instanceId: 'i',
      config: {},
      deployContent: { systemPrompt: 'p', assetMounts },
      toolPackagePins: [{ name: 'pkg', version: '1.0.0' }],
    });
  });
});

describe('toSendMultiStepDeploy', () => {
  test('forwards the definition and per-step sources to the sidecar', async () => {
    const sendAgentDeploy = mock(
      async (
        _agentAddress: string,
        _config: HarnessConfig,
        _workflow: {
          definition: { id: string };
          sources: Record<string, unknown>;
        }
      ) => ({ publicKey: 'pk' })
    );
    const sidecarRouter = { sendAgentDeploy } as unknown as SidecarRouter;
    const definition = { id: 'wf' } as unknown as WorkflowDefinition;
    const sources = { first: { id: 's1' } };

    const result = await toSendMultiStepDeploy(sidecarRouter)({
      agentAddress: 'dep@local',
      agentId: 'dep',
      config: {} as HarnessConfig,
      definition,
      sources: sources as never,
      hubPublicKey: 'hubkey',
    });

    const call = sendAgentDeploy.mock.calls.at(0);
    if (!call) throw new Error('sendAgentDeploy was not called');
    const [address, , workflow] = call;
    expect(address).toBe('dep@local');
    expect(workflow.definition.id).toBe('wf');
    expect(workflow.sources).toBe(sources);
    expect(result).toEqual({ publicKey: 'pk' });
  });
});

describe('writeStepAgentRows', () => {
  test('inserts one agent row per step keyed by the derived step agent id', async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeStepAgentRows({
      db,
      deploymentId: 'dep1',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      stepIds: ['intake', 'generate'],
      toolPackagePins: [{ name: '@workbench/tools-granola', version: '^0.1.0' }],
      capabilityNames: ['granola_list_notes'],
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error('insert().values was not called');
    const rows = call[0] as Array<{
      id: string;
      toolPackages: unknown;
      capabilities: unknown;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['ins_dep1-intake', 'ins_dep1-generate']);
    expect(rows[0]?.toolPackages).toEqual([
      { name: '@workbench/tools-granola', version: '^0.1.0' },
    ]);
    expect(rows[0]?.capabilities).toEqual({ tools: ['granola_list_notes'] });
  });

  test('writes nothing when the workflow has no steps', async () => {
    const insert = mock(() => ({ values: mock(async () => undefined) }));
    const db = { insert } as unknown as HubDb;
    await writeStepAgentRows({
      db,
      deploymentId: 'dep1',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      stepIds: [],
      toolPackagePins: [],
      capabilityNames: [],
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('writeStepInstanceRows', () => {
  test('inserts one agent_instance row per step with derived id, address, and deploying principal', async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeStepInstanceRows({
      db,
      deploymentId: 'dep1',
      deploymentDomain: 'gtm.localhost',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      stepIds: ['intake', 'generate'],
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error('insert().values was not called');
    const rows = call[0] as Array<{
      id: string;
      agentId: string;
      tenantId: string;
      principalId: string;
      address: string;
      status: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['ins_dep1-intake', 'ins_dep1-generate']);
    expect(rows.map((r) => r.address)).toEqual([
      'ins_dep1-intake@gtm.localhost',
      'ins_dep1-generate@gtm.localhost',
    ]);
    expect(rows[0]?.agentId).toBe('ins_dep1-intake');
    expect(rows[0]?.tenantId).toBe('t1');
    expect(rows[0]?.principalId).toBe('p1');
    expect(rows[0]?.status).toBe('deployed');
  });

  test('writes nothing when the workflow has no steps', async () => {
    const insert = mock(() => ({ values: mock(async () => undefined) }));
    const db = { insert } as unknown as HubDb;
    await writeStepInstanceRows({
      db,
      deploymentId: 'dep1',
      deploymentDomain: 'gtm.localhost',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      stepIds: [],
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('writeDeploymentAgentRow', () => {
  test('inserts the supervisor agent row keyed by ins_<deploymentId>', async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeDeploymentAgentRow({
      db,
      deploymentId: 'dep1',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error('insert().values was not called');
    const row = call[0] as {
      id: string;
      tenantId: string;
      creatorPrincipalId: string;
      toolPackages: unknown;
      capabilities: unknown;
      status: string;
    };
    expect(row.id).toBe('ins_dep1');
    expect(row.tenantId).toBe('t1');
    expect(row.creatorPrincipalId).toBe('p1');
    expect(row.status).toBe('deployed');
    // The supervisor is not tool-capable: no capabilities, no tool packages.
    expect(row.toolPackages).toEqual([]);
    expect(row.capabilities).toBeNull();
  });
});

describe('writeDeploymentInstanceRow', () => {
  test('inserts an active supervisor instance row at ins_<deploymentId>@<domain>', async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeDeploymentInstanceRow({
      db,
      deploymentId: 'dep1',
      deploymentDomain: 'gtm.localhost',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error('insert().values was not called');
    const row = call[0] as {
      id: string;
      agentId: string;
      tenantId: string;
      principalId: string;
      address: string;
      status: string;
      endedAt?: unknown;
    };
    expect(row.id).toBe('ins_dep1');
    expect(row.agentId).toBe('ins_dep1');
    expect(row.address).toBe('ins_dep1@gtm.localhost');
    expect(row.tenantId).toBe('t1');
    expect(row.principalId).toBe('p1');
    expect(row.status).toBe('deployed');
    expect(row.endedAt).toBeUndefined();
  });
});

describe('buildStepGrantRules', () => {
  test('emits one tool:<name>/invoke allow rule per de-duplicated capability', () => {
    const rules = buildStepGrantRules([
      'granola_list_notes',
      'gamma_generate',
      'granola_list_notes',
    ]);
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.resource)).toEqual([
      'tool:granola_list_notes',
      'tool:gamma_generate',
    ]);
    expect(rules.every((r) => r.action === 'invoke' && r.effect === 'allow')).toBe(true);
  });

  test('the rules are matched by the runtime evaluator the step reactor uses', async () => {
    const rules = buildStepGrantRules(['granola_list_notes']);
    const granted = await evaluateGrants(rules, 'tool:granola_list_notes', 'invoke');
    expect(granted.effect).toBe('allow');
    const ungranted = await evaluateGrants(rules, 'tool:gamma_generate', 'invoke');
    expect(ungranted.effect).not.toBe('allow');
  });
});

describe('writeStepGrantFiles', () => {
  test('writes state/grants.json into each step agent-state repo on the main ref', async () => {
    const writeTree = mock(
      async (
        _principal: { kind: string },
        _repoId: { kind: string; id: string },
        _ref: string,
        _content: { files: Record<string, string> }
      ) => ({ commitSha: 'sha' })
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    await writeStepGrantFiles({
      repoStore,
      deploymentId: 'dep1',
      stepIds: ['intake', 'generate'],
      capabilityNames: ['granola_list_notes'],
    });

    expect(writeTree).toHaveBeenCalledTimes(2);
    const [principal, repoId, ref, content] = writeTree.mock.calls[0]!;
    expect(principal).toEqual({ kind: 'hub' });
    expect(repoId).toEqual({ kind: 'agent-state', id: 'dep1-intake' });
    expect(ref).toBe('refs/heads/main');
    const parsed = JSON.parse(content.files['state/grants.json']!) as {
      grants: GrantRule[];
    };
    const allowed = await evaluateGrants(parsed.grants, 'tool:granola_list_notes', 'invoke');
    expect(allowed.effect).toBe('allow');
  });

  test('writes nothing when there are no steps', async () => {
    const writeTree = mock(async () => ({ commitSha: 'sha' }));
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;
    await writeStepGrantFiles({
      repoStore,
      deploymentId: 'dep1',
      stepIds: [],
      capabilityNames: ['granola_list_notes'],
    });
    expect(writeTree).not.toHaveBeenCalled();
  });
});

describe('collectGrants', () => {
  test('unions and dedups every grant across steps', () => {
    const walk: CapabilityWalkResult = {
      perStep: new Map([
        ['a', { grants: ['tool:x', 'director:default'] }],
        ['b', { grants: ['tool:x', 'inference.source:p:m'] }],
      ]),
      unresolvedDirectors: [],
    };
    expect([...collectGrants(walk)].sort()).toEqual([
      'director:default',
      'inference.source:p:m',
      'tool:x',
    ]);
  });
});

const TENANT_SOURCE: InferenceSource = {
  id: 'openai-compatible:m',
  provider: 'openai-compatible',
  baseURL: 'https://llm.example.com',
  apiKey: 'secret',
  model: 'm',
};

const VALID_DEFINITION = {
  id: 'pain-point-collateral',
  triggers: [{ type: 'manual' }],
  stepOrder: ['intake', 'analyze'],
  steps: { intake: { kind: 'step' }, analyze: { kind: 'step' } },
} as unknown as WorkflowDefinition;

describe('buildSupervisorDeployFrame', () => {
  test('targets the deployment-level address + agentId derived from the persisted deploymentId', () => {
    const frame = buildSupervisorDeployFrame({
      deploymentId: 'ses_abc',
      deploymentDomain: 'deploy.example.com',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      definition: VALID_DEFINITION,
      source: TENANT_SOURCE,
    });
    expect(frame.address).toBe(
      deriveDeploymentAddress({
        deploymentId: 'ses_abc',
        deploymentDomain: 'deploy.example.com',
      })
    );
    // The orchestrator overrides the base config's address/id to the deployment
    // level; a re-drive must reproduce that exactly so the frame targets the
    // supervisor address the original deploy registered.
    expect(frame.config.agentAddress).toBe(frame.address);
    expect(frame.config.agentId).toBe('ins_ses_abc');
  });

  test('pins one inference source per step id in the workflow projection', () => {
    const frame = buildSupervisorDeployFrame({
      deploymentId: 'ses_abc',
      deploymentDomain: 'deploy.example.com',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      definition: VALID_DEFINITION,
      source: TENANT_SOURCE,
    });
    expect(Object.keys(frame.workflow.sources).sort()).toEqual(['analyze', 'intake']);
    expect(frame.workflow.sources.intake).toBe(TENANT_SOURCE);
    expect(frame.workflow.sources.analyze).toBe(TENANT_SOURCE);
  });
});

describe('readWorkflowDefinition', () => {
  async function withRepoDir(fn: (dir: string, repoStore: AgentRepoStore) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'wf-read-'));
    const repoStore = {
      repoStore: { getRepoDir: () => dir },
    } as unknown as AgentRepoStore;
    try {
      await fn(dir, repoStore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('reads and validates workflow.json from the repo working tree', async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(join(dir, 'workflow.json'), JSON.stringify(VALID_DEFINITION), 'utf8');
      const out = await readWorkflowDefinition(repoStore, 'pain-point-collateral');
      expect(out.id).toBe('pain-point-collateral');
      expect(out.stepOrder).toEqual(['intake', 'analyze']);
    });
  });

  test('fails loudly when workflow.json is missing', async () => {
    await withRepoDir(async (_dir, repoStore) => {
      await expect(readWorkflowDefinition(repoStore, 'missing')).rejects.toThrow(
        /missing or unreadable/
      );
    });
  });

  test('fails loudly on corrupt (non-JSON) workflow.json', async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(join(dir, 'workflow.json'), '{ not json', 'utf8');
      await expect(readWorkflowDefinition(repoStore, 'corrupt')).rejects.toThrow(
        /missing or unreadable/
      );
    });
  });

  test('rejects a definition that fails envelope validation', async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(join(dir, 'workflow.json'), JSON.stringify({ not: 'a workflow' }), 'utf8');
      await expect(readWorkflowDefinition(repoStore, 'bad')).rejects.toThrow(
        /persisted definition is invalid/
      );
    });
  });
});

describe('ensureDeploymentRoutable', () => {
  function makeService(opts: {
    routableAddresses: string[];
    sendAgentDeploy: SidecarRouter['sendAgentDeploy'];
  }) {
    const sidecarRouter = {
      getRoutableAddresses: () => opts.routableAddresses,
      sendAgentDeploy: opts.sendAgentDeploy,
    } as unknown as SidecarRouter;
    return createWorkflowDeployService({
      db: {} as unknown as HubDb,
      repoStore: {
        repoStore: { writeTree: async () => ({ commitSha: 'sha' }) },
      } as unknown as AgentRepoStore,
      sidecarRouter,
      sessionService: {} as unknown as SessionService,
      directorRegistry: {} as unknown as DirectorRegistry,
    });
  }

  test('is a no-op when the supervisor address is already routable', async () => {
    const address = deriveDeploymentAddress({
      deploymentId: 'ses_live',
      deploymentDomain: 'deploy.example.com',
    });
    const sendAgentDeploy = mock(async () => ({ publicKey: 'pk' }));
    const service = makeService({
      routableAddresses: [address],
      sendAgentDeploy: sendAgentDeploy as unknown as SidecarRouter['sendAgentDeploy'],
    });

    const result = await service.ensureDeploymentRoutable({
      deploymentId: 'ses_live',
      kind: 'pain-point-collateral',
      tenantId: 't1',
      creatorPrincipalId: 'p1',
      deploymentDomain: 'deploy.example.com',
    });

    expect(result.reestablished).toBe(false);
    expect(sendAgentDeploy).not.toHaveBeenCalled();
  });
});
