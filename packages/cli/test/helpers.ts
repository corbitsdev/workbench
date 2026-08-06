// Test doubles for the hub HTTP boundary. Every verb takes its API
// caller as a dependency, so the whole hub collapses to one dispatch
// function per test; an unmatched call fails the test loudly instead
// of vanishing into a stubbed default.

import type { ApiCall } from "@workbench/hub-client";

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
export const ORG_SLUG = "workbench";
export const TENANT_DOMAIN = "workbench.localhost";

export function signUpResponse(): FakeResponse {
  return { status: 200, data: { user: { id: "usr_1" } } };
}

export function tenantRow() {
  return {
    id: TENANT_ID,
    name: "Workbench",
    slug: ORG_SLUG,
    domain: TENANT_DOMAIN,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

export function principalsResponse(): FakeResponse {
  return {
    status: 200,
    data: {
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "Workbench",
          tenantSlug: ORG_SLUG,
          kind: "user",
          status: "active",
          roles: [{ id: "rol_owner", name: "owner" }],
        },
      ],
      nextCursor: null,
    },
  };
}

export function rolesResponse(names: string[]): FakeResponse {
  return {
    status: 200,
    data: {
      data: names.map((name, index) => ({
        id: `rol_${index}`,
        tenantId: TENANT_ID,
        name,
        isSystem: true,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      })),
      nextCursor: null,
    },
  };
}
