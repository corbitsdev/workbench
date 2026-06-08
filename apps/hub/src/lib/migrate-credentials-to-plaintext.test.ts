import { describe, expect, it, mock } from 'bun:test';
import { encryptSecret, parseEncryptionKeys } from '@workbench/hub-crypto';
import {
  migrateCredentialsToPlaintext,
  verifyPlaintextMigration,
} from './migrate-credentials-to-plaintext';

const TEST_CREDENTIAL_KEYS = parseEncryptionKeys(`1:${Buffer.alloc(32, 0x01).toString('base64')}`);
const TEST_TENANT_ID = 'tenant-1';

describe('migrateCredentialsToPlaintext', () => {
  it('decrypts enc:v1:* credentials and re-stores as plaintext', async () => {
    const plaintextSecret = 'sk-test-key';
    const encryptedSecret = encryptSecret(TEST_CREDENTIAL_KEYS, TEST_TENANT_ID, plaintextSecret);

    // Mock DB: one encrypted credential
    const mockRow = {
      id: 'cred-1',
      tenantId: TEST_TENANT_ID,
      secret: encryptedSecret,
    };

    const updateCalls: Array<{ id: string; secret: string }> = [];
    const mockDb = {
      query: {
        credential: {
          findMany: mock(async () => [mockRow]),
        },
      },
      update: mock(() => ({
        set: mock((updates: Record<string, unknown>) => ({
          where: mock(async () => {
            updateCalls.push({ id: mockRow.id, secret: updates.secret as string });
          }),
        })),
      })),
    } as unknown as any;

    const result = await migrateCredentialsToPlaintext(mockDb, TEST_CREDENTIAL_KEYS);

    expect(result.migratedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(updateCalls[0]?.secret).toBe(plaintextSecret);
    expect(updateCalls[0]?.secret.startsWith('enc:')).toBe(false);
  });

  it('does nothing when no encrypted rows exist (SQL filter returns empty)', async () => {
    const mockDb = {
      query: {
        credential: {
          findMany: mock(async () => []),
        },
      },
      update: mock(() => ({})),
    } as unknown as any;

    const result = await migrateCredentialsToPlaintext(mockDb, TEST_CREDENTIAL_KEYS);

    expect(result.migratedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('handles decryption failures gracefully', async () => {
    // Simulate a credential encrypted with a different key (will fail to decrypt)
    const otherKeys = parseEncryptionKeys(`2:${Buffer.alloc(32, 0x02).toString('base64')}`);
    const encryptedSecret = encryptSecret(otherKeys, TEST_TENANT_ID, 'sk-test-key');

    const mockRow = {
      id: 'cred-1',
      tenantId: TEST_TENANT_ID,
      secret: encryptedSecret,
    };

    const mockDb = {
      query: {
        credential: {
          findMany: mock(async () => [mockRow]),
        },
      },
      update: mock(() => ({})),
    } as unknown as any;

    const result = await migrateCredentialsToPlaintext(mockDb, TEST_CREDENTIAL_KEYS);

    expect(result.failedCount).toBe(1);
    expect(result.migratedCount).toBe(0);
  });

  it('migrates multiple credentials independently', async () => {
    const secret1 = 'sk-key-1';
    const secret2 = 'sk-key-2';
    const encrypted1 = encryptSecret(TEST_CREDENTIAL_KEYS, TEST_TENANT_ID, secret1);
    const encrypted2 = encryptSecret(TEST_CREDENTIAL_KEYS, TEST_TENANT_ID, secret2);

    const mockRows = [
      { id: 'cred-1', tenantId: TEST_TENANT_ID, secret: encrypted1 },
      { id: 'cred-2', tenantId: TEST_TENANT_ID, secret: encrypted2 },
    ];

    const updateCalls: Array<{ id: string; secret: string }> = [];
    const mockDb = {
      query: {
        credential: {
          findMany: mock(async () => mockRows),
        },
      },
      update: mock(() => ({
        set: mock((updates: Record<string, unknown>) => ({
          where: mock(async () => {
            // This is a simplification; real update would have the ID context
            updateCalls.push({
              id: 'cred-' + updateCalls.length,
              secret: updates.secret as string,
            });
          }),
        })),
      })),
    } as unknown as any;

    const result = await migrateCredentialsToPlaintext(mockDb, TEST_CREDENTIAL_KEYS);

    expect(result.migratedCount).toBe(2);
    expect(updateCalls.length).toBe(2);
  });
});

describe('verifyPlaintextMigration', () => {
  it('returns 0 when all credentials are plaintext', async () => {
    const mockDb = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(async () => [{ count: 0 }]),
        })),
      })),
    } as unknown as any;

    const result = await verifyPlaintextMigration(mockDb);

    expect(result).toBe(0);
  });

  it('returns count of remaining encrypted credentials', async () => {
    const mockDb = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(async () => [{ count: 5 }]),
        })),
      })),
    } as unknown as any;

    const result = await verifyPlaintextMigration(mockDb);

    expect(result).toBe(5);
  });
});
