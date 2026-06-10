import { describe, expect, it } from 'bun:test';
import { resolveCredentialRequirement, getAncestorChain } from '@intx/db';
import { AGENT_TEMPLATES } from '@workbench/agents';

/**
 * Verification (not new code) that the CL-1445 org-credential inheritance holds
 * for the seeded template definitions: an org-level (tenant-owned) credential on
 * the GLOBAL tenant resolves at launch for a template's `credentialRequirements`
 * down the ancestor chain (workbench sub-tenant -> global root).
 *
 * Exercises Interchange's real `resolveCredentialRequirement` / `getAncestorChain`
 * against a fake `db.query` modeling the two-tenant hierarchy. The fakes ignore
 * drizzle `where` objects (opaque here) and answer from in-memory rows, driving
 * `tenant.findFirst` by the ancestor walk's call order.
 */

const GLOBAL_TENANT_ID = 'tnt_global';
const WORKBENCH_TENANT_ID = 'tnt_workbench';
const PROVIDER_ID = 'prov_openai';
const CREDENTIAL_NAME = 'Myra LLM';

// The org-level LLM credential lives on the global tenant, tenant-owned
// (principalId: null), matching the seeded templates' `source: 'tenant'`.
const ORG_CREDENTIAL = {
  id: 'cred_org_llm',
  tenantId: GLOBAL_TENANT_ID,
  providerId: PROVIDER_ID,
  principalId: null,
  name: CREDENTIAL_NAME,
  status: 'active',
  scopes: [],
};

type AncestorRow = { parentId: string | null };

describe('org credential inheritance for seeded templates (CL-1445)', () => {
  const myra = AGENT_TEMPLATES.find((t) => t.key === 'myra');

  it('the Myra template declares a tenant-sourced credential requirement', () => {
    expect(myra).toBeDefined();
    const req = myra?.credentialRequirements.find((r) => r.source === 'tenant');
    expect(req).toBeDefined();
  });

  it('getAncestorChain walks workbench -> global root', async () => {
    let tenantCall = 0;
    const ancestorRows: AncestorRow[] = [{ parentId: GLOBAL_TENANT_ID }, { parentId: null }];
    const db = {
      query: { tenant: { findFirst: () => Promise.resolve(ancestorRows[tenantCall++]) } },
    };
    const chain = await getAncestorChain(db as never, WORKBENCH_TENANT_ID);
    expect(chain).toEqual([WORKBENCH_TENANT_ID, GLOBAL_TENANT_ID]);
  });

  it('resolves the org-level credential for a tenant-sourced requirement down the chain', async () => {
    // Per-call credential answer: empty for the workbench tenant, the org
    // credential for the global tenant — i.e. it is inherited, not local.
    const credentialAnswers: Array<(typeof ORG_CREDENTIAL)[]> = [[], [ORG_CREDENTIAL]];
    let credCall = 0;
    // getAncestorChain is invoked twice (once inside resolveProviderByName, once
    // in resolveCredentialRequirement), so the leaf->root walk replays per call.
    const walkChild: AncestorRow = { parentId: GLOBAL_TENANT_ID };
    const walkRoot: AncestorRow = { parentId: null };
    const ancestorRows: AncestorRow[] = [walkChild, walkRoot, walkChild, walkRoot];
    let tenantCall = 0;

    const db = {
      query: {
        tenant: { findFirst: () => Promise.resolve(ancestorRows[tenantCall++]) },
        provider: {
          findFirst: () =>
            Promise.resolve({
              id: PROVIDER_ID,
              tenantId: GLOBAL_TENANT_ID,
              name: 'openai-compatible',
            }),
        },
        credential: { findMany: () => Promise.resolve(credentialAnswers[credCall++] ?? []) },
      },
    };

    const requirement = {
      providerName: 'openai-compatible',
      source: 'tenant' as const,
      name: CREDENTIAL_NAME,
    };

    const resolved = await resolveCredentialRequirement(
      db as never,
      WORKBENCH_TENANT_ID,
      requirement,
      null,
      null
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(ORG_CREDENTIAL.id);
    expect(resolved?.tenantId).toBe(GLOBAL_TENANT_ID);
    // Inherited from an ancestor, not the launching workbench tenant.
    expect(resolved?.tenantId).not.toBe(WORKBENCH_TENANT_ID);
  });
});
