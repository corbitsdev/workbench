#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Backfill principal-scoped instance grants for existing personal agents (CL-1635).
 *
 * Member personal-agent instances (Myra and other enabled templates) were
 * provisioned without the read/write/manage grants the owning member needs to
 * operate their own instance. Without `instance:<id>` read, the chat event
 * stream (`GET /instances/:id/events`) returns 403 on every page load. New
 * members get these grants at provisioning time; this repairs existing ones.
 *
 * Idempotent: only inserts grants that are missing, so it is safe to re-run.
 *
 * Required env vars:
 *   DATABASE_URL — Postgres connection string
 *
 * For local dev the same applies — point DATABASE_URL at the compose Postgres.
 */

import { generateId } from '@intx/hub-common';
import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[backfill-instance-grants] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[backfill-instance-grants] ${message}`);
}

const INSTANCE_ACTIONS = ['read', 'write', 'manage'] as const;

const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const mappings = await sql<
    { tenant_id: string; member_principal_id: string; instance_id: string }[]
  >`
    select m.tenant_id, m.member_principal_id, m.instance_id
    from member_agent_instance m
    join agent_instance i on i.id = m.instance_id
  `;
  log(`Found ${mappings.length} personal agent instance(s) to check`);

  let inserted = 0;
  for (const mapping of mappings) {
    const resource = `instance:${mapping.instance_id}`;
    for (const action of INSTANCE_ACTIONS) {
      const rows = await sql`
        insert into "grant" (id, tenant_id, principal_id, resource, action, effect, origin, created_at, updated_at)
        select ${generateId('grant')}, ${mapping.tenant_id}, ${mapping.member_principal_id}, ${resource}, ${action}, 'allow', 'system', now(), now()
        where not exists (
          select 1 from "grant" g
          where g.principal_id = ${mapping.member_principal_id}
            and g.resource = ${resource}
            and g.action = ${action}
        )
        returning id
      `;
      inserted += rows.length;
    }
  }

  log(`Inserted ${inserted} missing grant(s). Done.`);
} finally {
  await sql.end();
}
