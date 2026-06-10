/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { principalsToWorkbenches, principalToWorkbenchEntry, type Principal } from './hub-api';

describe('principalsToWorkbenches', () => {
  it('filters out the global org tenant by id', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-global',
        tenantId: 'tenant-global',
        tenantSlug: 'example-org',
        tenantName: 'Example Org',
        kind: 'user',
        status: 'active',
        roles: [],
      },
      {
        principalId: 'p-wb',
        tenantId: 'tenant-acme',
        tenantSlug: 'acme-sales',
        tenantName: 'Acme Sales',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, 'tenant-global');

    expect(workbenches).toHaveLength(1);
    expect(workbenches[0]!.id).toBe('p-wb');
    expect(workbenches[0]!.tenantName).toBe('Acme Sales');
  });

  it('returns empty list when user has only the global org tenant', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-global',
        tenantId: 'tenant-global',
        tenantSlug: 'example-org',
        tenantName: 'Example Org',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, 'tenant-global');
    expect(workbenches).toHaveLength(0);
  });

  it('returns all principals when globalTenantId is null', () => {
    const principals: Principal[] = [
      {
        principalId: 'p-1',
        tenantId: 'tenant-acme',
        tenantSlug: 'acme-sales',
        tenantName: 'Acme Sales',
        kind: 'user',
        status: 'active',
        roles: [],
      },
    ];

    const workbenches = principalsToWorkbenches(principals, null);
    expect(workbenches).toHaveLength(1);
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
