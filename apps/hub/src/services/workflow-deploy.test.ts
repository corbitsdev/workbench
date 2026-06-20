import { describe, expect, mock, test } from 'bun:test';
import type { CapabilityWalkResult } from '@intx/workflow-deploy';
import type { WorkflowDefinition } from '@intx/workflow';
import type { HarnessConfig } from '@intx/types/runtime';
import type { AgentRepoStore, SessionService, SidecarRouter } from '@intx/hub-sessions';
import type { HubDb } from '../db';
import {
  collectGrants,
  createWorkflowRepoWriter,
  toLaunchSession,
  toSendMultiStepDeploy,
  writeStepAgentRows,
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
