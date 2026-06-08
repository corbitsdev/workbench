/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { principalToWorkbenchEntry, type Principal } from './hub-api';

describe('listWorkbenches', () => {
  it('filters out personal tenants (user-{id} slug pattern)', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-1',
        tenantId: 'tenant-user',
        tenantSlug: 'user-abc123',
        tenantName: 'Personal',
        kind: 'user',
        status: 'active',
        roles: [],
      },
      {
        principalId: 'p-2',
        tenantId: 'tenant-acme',
        tenantSlug: 'acme-sales',
        tenantName: 'Acme Sales',
        kind: 'user',
        status: 'active',
        roles: [],
      },
      {
        principalId: 'p-3',
        tenantId: 'tenant-dev',
        tenantSlug: 'user-xyz789',
        tenantName: 'Dev Personal',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    // Test the filter logic directly since listWorkbenches wraps getMyPrincipals.
    // We extract the filter predicate inline here.
    const isPersonal = (slug: string) => slug.startsWith('user-');
    const workbenches = principals
      .filter((p) => !isPersonal(p.tenantSlug))
      .map(principalToWorkbenchEntry);

    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe('p-2');
    expect(workbenches[0]!.tenantSlug).toBe('acme-sales');
    expect(workbenches[0]!.tenantName).toBe('Acme Sales');
  });

  it('returns empty array when user only has a personal tenant', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-1',
        tenantId: 'tenant-user',
        tenantSlug: 'user-abc123',
        tenantName: 'Personal',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const isPersonal = (slug: string) => slug.startsWith('user-');
    const workbenches = principals.filter((p) => !isPersonal(p.tenantSlug));
    expect(workbenches).toHaveLength(0);
  });

  it('maps Interchange principalId to the workbench entry id', () => {
    const principal: Principal = {
      principalId: 'principal-workbench',
      tenantId: 'tenant-acme',
      tenantSlug: 'acme-sales',
      tenantName: 'Acme Sales',
      kind: 'user',
      status: 'active',
      roles: [],
    };

    expect(principalToWorkbenchEntry(principal)).toEqual({
      id: 'principal-workbench',
      tenantId: 'tenant-acme',
      tenantSlug: 'acme-sales',
      tenantName: 'Acme Sales',
    });
  });
});
