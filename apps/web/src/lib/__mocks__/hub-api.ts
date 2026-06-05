/// <reference types="bun" />
import { mock } from 'bun:test';
import type {
  MeResponse,
  Principal,
  TenantResponse,
  WorkspaceResponse,
  WorkbenchEntry,
  TenantDetailResponse,
  PrincipalDetail,
  CredentialDetail,
  GrantDetail,
  AgentInstance,
  SetupMyraCredentialInput,
  ProvisionAgentInput,
  ProvisionAgentResponse,
} from '../hub-api';

export function createMockHubApi(overrides?: Record<string, any>) {
  const defaults = {
    getMe: mock<() => Promise<MeResponse>>(() =>
      Promise.resolve({
        userId: '',
        userName: '',
        personalTenantId: null,
        paInstanceId: null,
        provisioned: false,
      })
    ),
    getMyPrincipals: mock<() => Promise<Principal[]>>(() => Promise.resolve([])),
    createTenant: mock<(name: string, slug: string) => Promise<TenantResponse>>(() =>
      Promise.resolve({ id: '', name: '', slug: '', domain: '' })
    ),
    createWorkspace: mock<(name: string) => Promise<WorkspaceResponse>>(() =>
      Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })
    ),
    listWorkbenches: mock<() => Promise<WorkbenchEntry[]>>(() => Promise.resolve([])),
    getTenant: mock<(tenantId: string) => Promise<TenantDetailResponse>>(() =>
      Promise.resolve({
        id: '',
        name: '',
        slug: '',
        domain: '',
        parentId: null,
        createdAt: '',
        updatedAt: '',
      })
    ),
    listTenantPrincipals: mock<(tenantId: string) => Promise<PrincipalDetail[]>>(() =>
      Promise.resolve([])
    ),
    getPrincipal: mock<(tenantId: string, principalId: string) => Promise<PrincipalDetail>>(() =>
      Promise.resolve({
        id: '',
        tenantId: '',
        kind: 'user',
        refId: '',
        displayName: '',
        status: 'active' as const,
        roles: [],
        createdAt: '',
        updatedAt: '',
      })
    ),
    listTenantCredentials: mock<(tenantId: string) => Promise<CredentialDetail[]>>(() =>
      Promise.resolve([])
    ),
    listPrincipalGrants: mock<(tenantId: string, principalId: string) => Promise<GrantDetail[]>>(
      () => Promise.resolve([])
    ),
    listAgentInstances: mock<(tenantId: string) => Promise<AgentInstance[]>>(() =>
      Promise.resolve([])
    ),
    setupMyraCredential: mock<(input: SetupMyraCredentialInput) => Promise<void>>(() =>
      Promise.resolve()
    ),
    provisionAgent: mock<(input: ProvisionAgentInput) => Promise<ProvisionAgentResponse>>(() =>
      Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })
    ),
  };

  return { ...defaults, ...overrides };
}
