#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Remove a user from a workbench tenant (direct DB — no API auth needed).
 *
 * Lists all workbench tenants and all users, then removes the selected
 * user's principal from the selected workbench. The user's data is preserved.
 *
 * Required env:
 *   DATABASE_URL  — Postgres connection string
 *
 * Optional:
 *   SELF_EMAIL    — your email; users matching this are marked (you) in the list
 *                   (default: sawyer@abklabs.com)
 */

import * as readline from 'readline';
import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[remove-workbench-member] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const SELF_EMAIL = process.env['SELF_EMAIL'] ?? 'sawyer@abklabs.com';
const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

try {
  // Load all workbench tenants (tenants with a parentId, excluding personal tenants).
  // Workbench tenants are child tenants of the global org.
  const workbenches = await sql<{ id: string; name: string; slug: string }[]>`
    select t.id, t.name, t.slug
    from tenant t
    where t.parent_id is not null
      and (
        select count(*) from principal p
        where p.tenant_id = t.id and p.kind = 'user'
      ) > 1
    order by t.name
  `;

  if (workbenches.length === 0) {
    console.log('[remove-workbench-member] No workbench tenants found.');
    process.exit(0);
  }

  console.log('\nWorkbenches:');
  workbenches.forEach((wb, i) => {
    console.log(`  [${i + 1}] ${wb.name} (${wb.slug})`);
  });

  const wbIdxStr = await prompt('\nSelect workbench number: ');
  const wbIdx = parseInt(wbIdxStr, 10) - 1;
  if (isNaN(wbIdx) || wbIdx < 0 || wbIdx >= workbenches.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  const workbench = workbenches[wbIdx]!;

  // Load members of this workbench.
  const members = await sql<
    { principal_id: string; user_id: string; email: string; display_name: string }[]
  >`
    select p.id as principal_id, u.id as user_id, u.email, u.name as display_name
    from principal p
    join "user" u on u.id = p.ref_id
    where p.tenant_id = ${workbench.id}
      and p.kind = 'user'
    order by u.name
  `;

  if (members.length === 0) {
    console.log(`\n[remove-workbench-member] No user members in "${workbench.name}".`);
    process.exit(0);
  }

  console.log(`\nMembers of "${workbench.name}":`);
  members.forEach((m, i) => {
    const self = m.email === SELF_EMAIL ? ' (you)' : '';
    console.log(`  [${i + 1}] ${m.display_name} <${m.email}>${self}`);
  });

  const memberIdxStr = await prompt('\nSelect member number to remove (or q to quit): ');
  if (memberIdxStr === 'q') process.exit(0);

  const memberIdx = parseInt(memberIdxStr, 10) - 1;
  if (isNaN(memberIdx) || memberIdx < 0 || memberIdx >= members.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  const member = members[memberIdx]!;

  if (member.email === SELF_EMAIL) {
    console.error(`[remove-workbench-member] Refusing to remove yourself (${SELF_EMAIL}).`);
    process.exit(1);
  }

  const confirm = await prompt(
    `\nRemove ${member.display_name} <${member.email}> from "${workbench.name}"? Their data stays. [y/N] `
  );
  if (confirm.toLowerCase() !== 'y') {
    console.log('Aborted.');
    process.exit(0);
  }

  // Reassign agents created by this principal to the self principal.
  // First try within the workbench, then fall back to any tenant.
  const selfPrincipals = await sql<{ id: string }[]>`
    select p.id from principal p
    join "user" u on u.id = p.ref_id
    where p.kind = 'user'
      and u.email = ${SELF_EMAIL}
    order by (p.tenant_id = ${workbench.id}) desc
    limit 1
  `;
  const selfPrincipal = selfPrincipals[0];
  if (!selfPrincipal) {
    console.error(
      `[remove-workbench-member] Cannot find any principal for ${SELF_EMAIL} in the database.`
    );
    process.exit(1);
  }
  await sql`
    update agent set creator_principal_id = ${selfPrincipal.id}
    where creator_principal_id = ${member.principal_id}
  `;

  // Delete role assignments (FK constraint).
  await sql`
    delete from principal_role
    where principal_id = ${member.principal_id}
  `;

  // Delete the principal row (grants/credentials with onDelete cascade will follow).
  await sql`
    delete from principal
    where id = ${member.principal_id}
  `;

  console.log(
    `[remove-workbench-member] Removed ${member.display_name} from "${workbench.name}". Data preserved.`
  );
} finally {
  await sql.end();
}
