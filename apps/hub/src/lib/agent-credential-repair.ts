import { and, eq, isNull } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';

const log = getLogger(['api', 'agent-credential-repair']);

const { agent, credential, principal, provider: providerTable } = intxSchema;

type ProductionDB = DB['db'];

// Narrow structural view used by the repair pass. Mirrors the real Drizzle
// surface we touch so tests can supply a hand-built mock (see ProvisioningDB
// in tenant-provisioning.ts for the same pattern).
export type RepairDB = {
  query: {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    principal: { findMany: (opts: any) => Promise<Array<{ tenantId: string }>> };
    credential: {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      findMany: (opts: any) => Promise<Array<{ id: string; name: string; providerId: string }>>;
    };
    provider: {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      findFirst: (
        opts: any
      ) => Promise<{ id: string; name: string; metadata: unknown } | undefined>;
    };
    agent: {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      findMany: (opts: any) => Promise<
        Array<{
          id: string;
          credentialRequirements: unknown;
          modelConfig: unknown;
        }>
      >;
    };
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
  update: (table: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    set: (values: any) => {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      where: (cond: any) => Promise<unknown>;
    };
  };
};

type CredentialRequirement = {
  source?: string;
  name?: string;
  providerName?: string;
  [k: string]: unknown;
};

// A tenant credential enriched with the provider name and model the workbench
// stores in provider metadata. This is what an agent definition needs to bind
// to: providerName (resolves the provider) + model (modelConfig.defaultModel).
type TenantCredential = {
  name: string;
  providerName: string;
  model: string | null;
};

/**
 * Repair every agent definition in every tenant where the user is a principal.
 * Idempotent and additive — see {@link repairTenantAgentCredentials}.
 */
export async function repairUserAgentCredentials(db: RepairDB, userId: string): Promise<void> {
  const principals = await db.query.principal.findMany({
    where: and(eq(principal.kind, 'user'), eq(principal.refId, userId)),
  });

  const tenantIds = [...new Set(principals.map((p) => p.tenantId))];
  for (const tenantId of tenantIds) {
    await repairTenantAgentCredentials(db, tenantId);
  }
}

/**
 * Repair agent definitions in a single tenant so they can resolve inference
 * sources at launch. Interchange resolution needs two fields on the agent
 * definition: a `credentialRequirements` entry whose `providerName` matches a
 * tenant provider, and a `modelConfig.defaultModel`. Agents provisioned before
 * those fields were populated (e.g. pre-Myra users) have neither and never
 * launch.
 *
 * This pass derives both from the tenant's own active tenant-owned credentials,
 * so each tenant gets its own model + credentials for the same logical agent.
 * It is strictly additive: it only fills missing `providerName`, adds a missing
 * tenant requirement, and sets `defaultModel` when absent. It never overwrites a
 * model or provider a user already chose, and it never guesses when a tenant has
 * multiple credentials and the agent has no requirement to disambiguate.
 */
export async function repairTenantAgentCredentials(db: RepairDB, tenantId: string): Promise<void> {
  const creds = await db.query.credential.findMany({
    where: and(
      eq(credential.tenantId, tenantId),
      isNull(credential.principalId),
      eq(credential.status, 'active')
    ),
  });
  if (creds.length === 0) return;

  const enriched: TenantCredential[] = [];
  for (const cred of creds) {
    const prov = await db.query.provider.findFirst({
      where: eq(providerTable.id, cred.providerId),
    });
    if (!prov) continue;
    const meta = prov.metadata as { model?: string } | null;
    enriched.push({
      name: cred.name,
      providerName: prov.name,
      model: meta?.model ?? null,
    });
  }
  if (enriched.length === 0) return;

  // The credential to bind an unconfigured agent to. Only safe when the tenant
  // has exactly one — with several we cannot guess which the agent wants.
  const soleCredential = enriched.length === 1 ? enriched[0]! : null;

  const agents = await db.query.agent.findMany({
    where: eq(agent.tenantId, tenantId),
  });

  for (const agentRow of agents) {
    const reqs: CredentialRequirement[] = Array.isArray(agentRow.credentialRequirements)
      ? (agentRow.credentialRequirements as CredentialRequirement[]).map((r) => ({ ...r }))
      : [];
    const existingModel = (agentRow.modelConfig as { defaultModel?: string } | null)?.defaultModel;

    let changed = false;
    let model: string | null = existingModel ?? null;

    // 1. Fill providerName/model on existing tenant requirements. Provider name
    //    may already be present on newer definitions; modelConfig still has to
    //    be derived from the selected credential's provider metadata.
    for (const req of reqs) {
      if (req.source !== 'tenant') continue;
      const match = enriched.find((e) => e.name === req.name) ?? soleCredential;
      if (!match) continue;
      if (!req.providerName) {
        req.providerName = match.providerName;
        changed = true;
      }
      if (!model) model = match.model;
    }

    // 2. If the agent declares no tenant requirement at all, bind it to the
    //    sole tenant credential. With multiple credentials, skip and warn —
    //    binding to an arbitrary one would be wrong.
    const hasTenantReq = reqs.some((r) => r.source === 'tenant');
    if (!hasTenantReq) {
      if (soleCredential) {
        reqs.push({
          source: 'tenant',
          name: soleCredential.name,
          providerName: soleCredential.providerName,
        });
        if (!model) model = soleCredential.model;
        changed = true;
      } else {
        log.warn('Agent has no tenant credential requirement and tenant has multiple credentials', {
          agentId: agentRow.id,
          tenantId,
          credentialCount: enriched.length,
        });
      }
    }

    const needsModel = !existingModel && model !== null;
    if (!changed && !needsModel) continue;

    await db
      .update(agent)
      .set({
        credentialRequirements: reqs,
        ...(needsModel ? { modelConfig: { defaultModel: model } } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agent.id, agentRow.id));

    log.info('Repaired agent credential requirements', { agentId: agentRow.id, tenantId });
  }
}

export type { ProductionDB as RepairProductionDB };
