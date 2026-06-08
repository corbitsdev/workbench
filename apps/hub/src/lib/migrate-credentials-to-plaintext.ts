import type { DB } from '@intx/db';
import { sql, eq } from 'drizzle-orm';
import { credential } from '@intx/db/schema';
import { decryptSecret } from '@workbench/hub-crypto';
import type { CredentialKeyRegistry } from '@workbench/hub-crypto';
import { getLogger } from '@intx/log';

const log = getLogger(['migration', 'credentials-plaintext']);

export async function migrateCredentialsToPlaintext(
  db: DB['db'],
  credentialKeys: CredentialKeyRegistry
): Promise<{ migratedCount: number; failedCount: number }> {
  log.info('Starting credentials plaintext migration');

  const encryptedRows = await db.query.credential.findMany({
    where: sql`secret LIKE ${'enc:%'}`,
  });

  let migratedCount = 0;
  let failedCount = 0;

  for (const row of encryptedRows) {
    try {
      const plaintext = decryptSecret(credentialKeys, row.tenantId, row.secret);

      // Update the row with plaintext
      await db
        .update(credential)
        .set({ secret: plaintext, updatedAt: new Date() })
        .where(eq(credential.id, row.id));

      migratedCount++;
      log.debug('Migrated credential to plaintext', { credentialId: row.id });
    } catch (error) {
      failedCount++;
      log.error('Failed to migrate credential', {
        credentialId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info('Credentials plaintext migration complete', { migratedCount, failedCount });

  return { migratedCount, failedCount };
}

export async function verifyPlaintextMigration(db: DB['db']): Promise<number> {
  const encryptedCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(credential)
    .where(sql`secret LIKE ${'enc:%'}`)
    .then((result) => result[0]?.count ?? 0);

  if (encryptedCount === 0) {
    log.info('Plaintext migration verification passed: 0 encrypted credentials remain');
  } else {
    log.warn('Plaintext migration verification failed', { encryptedCount });
  }

  return encryptedCount;
}
