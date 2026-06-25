#!/usr/bin/env bun
/**
 * Runs as part of the Railway preDeployCommand, after db-setup.ts.
 *
 * Seeds providers and credentials directly via the database so the step can
 * run before the hub is listening (no HTTP auth loop). Skipped when
 * SEED_CREDENTIALS_ON_STARTUP is not "true".
 *
 * Credentials are stored plaintext (CL-1521 removed at-rest encryption).
 * Each entry is an upsert: existing name match → update secret + metadata;
 * no match → insert. Safe to run on every deploy.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, isNull } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { buildEntries } from "./seed-credentials";

if (process.env["SEED_CREDENTIALS_ON_STARTUP"] !== "true") {
  console.log("[seed-startup] SEED_CREDENTIALS_ON_STARTUP not set — skipping");
  process.exit(0);
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("[seed-startup] DATABASE_URL is required");
  process.exit(1);
}

const tenantSlug = process.env["GLOBAL_TENANT_SLUG"];
if (!tenantSlug) {
  console.error("[seed-startup] GLOBAL_TENANT_SLUG is required");
  process.exit(1);
}

const sql = postgres(databaseUrl);
const db = drizzle(sql, { schema: intxSchema });

const tenant = await db.query.tenant.findFirst({
  where: eq(intxSchema.tenant.slug, tenantSlug),
});

if (!tenant) {
  console.error(
    `[seed-startup] Tenant not found: ${tenantSlug} — run db-setup.ts first`,
  );
  await sql.end();
  process.exit(1);
}

const tenantId = tenant.id;
console.log(`[seed-startup] Tenant: ${tenantSlug} (${tenantId})`);

const entries = buildEntries();
if (entries.length === 0) {
  console.log("[seed-startup] No credentials configured — nothing to seed");
  await sql.end();
  process.exit(0);
}

const now = new Date();

try {
  for (const entry of entries) {
    try {
      const existingProvider = await db.query.provider.findFirst({
        where: and(
          eq(intxSchema.provider.tenantId, tenantId),
          eq(intxSchema.provider.name, entry.providerName),
        ),
      });

      let providerId: string;

      if (existingProvider) {
        if (entry.metadata) {
          const merged = {
            ...((existingProvider.metadata as Record<string, unknown> | null) ??
              {}),
            ...entry.metadata,
          };
          await db
            .update(intxSchema.provider)
            .set({ metadata: merged, updatedAt: now })
            .where(eq(intxSchema.provider.id, existingProvider.id));
          console.log(
            `[seed-startup]   Provider ${entry.providerName}: updated`,
          );
        } else {
          console.log(
            `[seed-startup]   Provider ${entry.providerName}: unchanged`,
          );
        }
        providerId = existingProvider.id;
      } else {
        providerId = generateId("provider");
        await db.insert(intxSchema.provider).values({
          id: providerId,
          tenantId,
          name: entry.providerName,
          plugin: entry.providerPlugin,
          metadata: entry.metadata ?? null,
          authorizationUrl: null,
          tokenUrl: null,
          userInfoUrl: null,
          scopes: null,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[seed-startup]   Provider ${entry.providerName}: created`);
      }

      const existingCredential = await db.query.credential.findFirst({
        where: and(
          eq(intxSchema.credential.tenantId, tenantId),
          eq(intxSchema.credential.name, entry.credentialName),
          isNull(intxSchema.credential.principalId),
        ),
      });

      if (existingCredential) {
        await db
          .update(intxSchema.credential)
          .set({
            secret: entry.secret,
            ...(entry.metadata ? { metadata: entry.metadata } : {}),
            updatedAt: now,
          })
          .where(eq(intxSchema.credential.id, existingCredential.id));
        console.log(
          `[seed-startup]   Credential ${entry.credentialName}: updated`,
        );
      } else {
        await db.insert(intxSchema.credential).values({
          id: generateId("credential"),
          tenantId,
          providerId,
          principalId: null,
          oauthClientId: null,
          name: entry.credentialName,
          type: "api_key",
          description: null,
          secret: entry.secret,
          refreshSecret: null,
          scopes: null,
          expiresAt: null,
          metadata: entry.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        });
        console.log(
          `[seed-startup]   Credential ${entry.credentialName}: created`,
        );
      }
    } catch (err) {
      console.error(
        `[seed-startup]   Error seeding ${entry.credentialName}:`,
        err,
      );
    }
  }

  console.log("[seed-startup] Done.");
} finally {
  await sql.end();
}
