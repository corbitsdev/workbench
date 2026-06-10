/// <reference types="bun" />
import { mock } from 'bun:test';
import type {
  MeResponse,
  Principal,
  WorkbenchResponse,
  WorkbenchEntry,
  AgentInstance,
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
        credentialResolved: false,
      })
    ),
    getMyPrincipals: mock<() => Promise<Principal[]>>(() => Promise.resolve([])),
    createWorkbench: mock<(name: string) => Promise<WorkbenchResponse>>(() =>
      Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })
    ),
    listWorkbenches: mock<() => Promise<WorkbenchEntry[]>>(() => Promise.resolve([])),
    listAgentInstances: mock<(tenantId: string) => Promise<AgentInstance[]>>(() =>
      Promise.resolve([])
    ),
  };

  return { ...defaults, ...overrides };
}
