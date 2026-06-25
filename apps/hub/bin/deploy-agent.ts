#!/usr/bin/env bun

/**
 * Deploy a single agent template definition into a specific tenant (CL-2234).
 *
 * Background: `resolveInstanceModelSources` is tenant-exact for the agent
 * DEFINITION — an instance in a child tenant cannot resolve a definition that
 * lives only in the parent. Boot-time `seedAgentTemplates` seeds every template
 * into the global org tenant, so a shared agent (e.g. Oat) whose instances are
 * created in a child workbench tenant launches with
 * `No resolvable inference sources … no_requirements` → 503. The fix is to
 * place the SAME definition into the instance's tenant.
 *
 * This script writes (idempotent upsert) the definition from
 * `AGENT_TEMPLATES[--template]` into the tenant resolved from `--tenant <slug>`,
 * reusing the exact `seedAgentTemplateIntoTenant` row logic the boot seeder uses
 * so the two never drift. It connects directly to the DATABASE_URL — no hub
 * redeploy required.
 *
 * Usage:
 *   DATABASE_URL=… bun apps/hub/bin/deploy-agent.ts --template oat --tenant gtm
 *
 * `--tenant` matches a tenant by slug OR by domain (slugs in this codebase are
 * stored as the bare label, e.g. `gtm`, while the tenant's domain may be
 * `gtm.localhost`). Fails loudly on an unknown template id or unresolved tenant.
 */

import { eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseArgs } from "node:util";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { schema } from "../src/db";
import { seedAgentTemplateIntoTenant } from "../src/lib/tenant-provisioning";

const Args = type({
  template: "string",
  tenant: "string",
});

const { tenant } = intxSchema;

export function resolveTemplate(templateId: string) {
  const template = AGENT_TEMPLATES.find((t) => t.key === templateId);
  if (!template) {
    const known = AGENT_TEMPLATES.map((t) => t.key).join(", ");
    throw new Error(
      `deploy-agent: unknown template "${templateId}" (known: ${known})`,
    );
  }
  return template;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`deploy-agent: ${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      template: { type: "string" },
      tenant: { type: "string" },
    },
    strict: true,
  });

  const parsed = Args(values);
  if (parsed instanceof type.errors) {
    throw new Error(
      `deploy-agent: --template <id> and --tenant <slug> are required (${parsed.summary})`,
    );
  }

  const template = resolveTemplate(parsed.template);

  const sql = postgres(requireEnv("DATABASE_URL"), { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    const targetTenant = await db.query.tenant.findFirst({
      where: or(
        eq(tenant.slug, parsed.tenant),
        eq(tenant.domain, parsed.tenant),
      ),
    });
    if (!targetTenant) {
      throw new Error(
        `deploy-agent: no tenant matching slug or domain "${parsed.tenant}"`,
      );
    }

    const { agentId } = await seedAgentTemplateIntoTenant(
      db,
      targetTenant.id,
      template,
    );

    process.stdout.write(
      `Deployed template "${template.key}" (${template.name}) into tenant ` +
        `${targetTenant.slug} [${targetTenant.id}] as agent ${agentId}\n`,
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await main();
}
