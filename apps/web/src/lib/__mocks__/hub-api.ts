/// <reference types="bun" />
import { mock } from "bun:test";
import type {
  MeResponse,
  Principal,
  WorkbenchEntry,
  AgentInstance,
} from "../hub-api";

export function createMockHubApi(overrides?: Record<string, any>) {
  const defaults = {
    getMe: mock<() => Promise<MeResponse>>(() =>
      Promise.resolve({
        userId: "",
        userName: "",
        personalTenantId: null,
        rootTenantIds: [],
        paInstanceId: null,
        provisioned: false,
        credentialResolved: false,
      }),
    ),
    getMyPrincipals: mock<() => Promise<Principal[]>>(() =>
      Promise.resolve([]),
    ),
    listWorkbenches: mock<() => Promise<WorkbenchEntry[]>>(() =>
      Promise.resolve([]),
    ),
    listAgentInstances: mock<(tenantId: string) => Promise<AgentInstance[]>>(
      () => Promise.resolve([]),
    ),
  };

  return { ...defaults, ...overrides };
}
