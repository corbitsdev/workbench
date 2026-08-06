// Test doubles for the hub HTTP boundary. Every call to `seedTenant`
// takes its API caller as a dependency, so the whole hub collapses to
// one dispatch function per test; an unmatched call fails the test
// loudly instead of vanishing into a stubbed default.

import type { ApiCall } from "../src/hub";

export type FakeResponse = { status: number; data: unknown };

export type FakeHandler = (
  method: string,
  path: string,
  body: unknown,
) => FakeResponse | undefined;

export function fakeAPI(handler: FakeHandler): ApiCall {
  return async (method, path, body) => {
    const response = handler(method, path, body);
    if (!response) {
      throw new Error(`unexpected hub call: ${method} ${path}`);
    }
    return { status: response.status, data: response.data, cookies: [] };
  };
}

export function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const TENANT_ID = "ten_1";
export const PRINCIPAL_ID = "prn_1";
export const TENANT_DOMAIN = "workbench.localhost";

export function assetRow(id: string, name: string) {
  return {
    id,
    tenantId: TENANT_ID,
    kind: "workflow",
    name,
    displayName: null,
    creatorPrincipalId: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

export function deploymentRow(id: string, assetId: string, status: string) {
  return {
    id,
    tenantId: TENANT_ID,
    definitionAssetId: assetId,
    status,
    createdAt: TIMESTAMP,
  };
}

export function emptyPage(): FakeResponse {
  return { status: 200, data: { data: [], nextCursor: null } };
}
