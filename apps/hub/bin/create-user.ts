#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Owner-run script to create (or reset the password of) an email/password user
 * directly in the database — no public sign-up route needed.
 *
 * The password is hashed with Bun.password (argon2id), which matches the
 * better-auth `emailAndPassword.password` hook configured in apps/hub/src/index.ts,
 * so the user can sign in via the email/password form afterward.
 *
 * Global-tenant membership and the personal Myra agent are NOT created here:
 * better-auth's `session.create.after` hook runs `ensureGlobalMember` on first
 * login, and `/api/v1/me` provisions Myra. So: run this, then sign in.
 *
 * Bun auto-loads `.env` from the working directory, so run from the repo root.
 *
 * Env / args (args override env):
 *   DATABASE_URL — Postgres connection string (required)
 *   --email      — user email (required)
 *   --password   — plaintext password to set (required)
 *   --name       — display name (defaults to the email local-part)
 *
 * Usage:
 *   bun apps/hub/bin/create-user.ts --email tester@example.com --password 'hunter2' --name Tester
 */

import postgres from 'postgres';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`[create-user] Missing ${name}`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = required('DATABASE_URL', process.env['DATABASE_URL']);
const email = required('--email', arg('--email'));
const password = required('--password', arg('--password'));
const name = arg('--name') ?? email.split('@')[0] ?? email;

const passwordHash = await Bun.password.hash(password);
const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      select id from "user" where email = ${email} limit 1
    `;

    let userId: string;
    if (existing) {
      userId = existing.id;
      console.log(`[create-user] User exists (${userId}); resetting password`);
    } else {
      userId = crypto.randomUUID();
      await tx`
        insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values (${userId}, ${name}, ${email}, true, now(), now())
      `;
      console.log(`[create-user] Created user ${userId} (${email})`);
    }

    const [credential] = await tx<{ id: string }[]>`
      select id from account
      where user_id = ${userId} and provider_id = 'credential'
      limit 1
    `;

    if (credential) {
      await tx`
        update account set password = ${passwordHash}, updated_at = now()
        where id = ${credential.id}
      `;
      console.log(`[create-user] Updated credential password`);
    } else {
      await tx`
        insert into account (id, user_id, account_id, provider_id, password, created_at, updated_at)
        values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', ${passwordHash}, now(), now())
      `;
      console.log(`[create-user] Linked credential account`);
    }
  });

  console.log(`[create-user] Done. Sign in at the login form with ${email}.`);
} finally {
  await sql.end();
}
