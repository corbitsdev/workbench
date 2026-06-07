import { eq, and } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';
import { generateKeyPair, createNodeCrypto } from '@intx/crypto-node';
import type { SessionService } from '@intx/hub-sessions';
const log = getLogger(['api', 'oat-scheduler']);

// Must match SCHEDULER_ADDRESS in packages/agents/src/granola/director.ts.
const SCHEDULER_ADDRESS = 'scheduler@system';

const { agent, agentInstance } = intxSchema;

const POLL_INTERVAL_MS = 60_000;

/**
 * Structural DB type scoped to what the Oat scheduler needs.
 * Avoids coupling to the full DB type.
 */
export type OatSchedulerDB = {
  // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
  select: (fields?: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    from: (table: any) => {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      innerJoin: (
        table: any,
        on: any
      ) => {
        // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
        where: (condition: any) => Promise<any[]>;
      };
    };
  };
};

type OatInstanceRow = {
  id: string;
  address: string;
  tenantId: string;
  sessionId: string | null;
};

/**
 * Query all running Oat agent instances across all tenants.
 */
async function queryOatInstances(db: OatSchedulerDB): Promise<OatInstanceRow[]> {
  return db
    .select({
      id: agentInstance.id,
      address: agentInstance.address,
      tenantId: agentInstance.tenantId,
      sessionId: agentInstance.sessionId,
    })
    .from(agentInstance)
    .innerJoin(agent, eq(agentInstance.agentId, agent.id))
    .where(and(eq(agent.name, 'Oat'), eq(agentInstance.status, 'running')));
}

// Per-instance crypto providers, lazily initialised and reused across ticks.
const cryptoCache = new Map<string, Promise<ReturnType<typeof createNodeCrypto>>>();

function getCryptoProvider(instanceId: string): Promise<ReturnType<typeof createNodeCrypto>> {
  let pending = cryptoCache.get(instanceId);
  if (pending !== undefined) return pending;
  pending = generateKeyPair().then((kp) => createNodeCrypto(kp));
  cryptoCache.set(instanceId, pending);
  return pending;
}

/**
 * Send a Granola sync trigger to every running Oat instance.
 * Exported so tests can call it directly.
 */
export async function triggerOatInstances(
  db: OatSchedulerDB,
  sessionService: SessionService
): Promise<void> {
  let instances: OatInstanceRow[];
  try {
    instances = await queryOatInstances(db);
  } catch (err) {
    log.error('Oat scheduler: failed to query instances', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }

  // Evict crypto entries for instances that are no longer running.
  const activeIds = new Set(instances.map((i) => i.id));
  for (const id of cryptoCache.keys()) {
    if (!activeIds.has(id)) {
      cryptoCache.delete(id);
    }
  }

  for (const instance of instances) {
    if (!instance.sessionId) {
      log.debug('Oat scheduler: skipping instance with no active session', {
        instanceId: instance.id,
      });
      continue;
    }

    const mailId = generateId('sessionMail');
    const cryptoProvider = await getCryptoProvider(instance.id);

    try {
      await sessionService.sendUserMessage({
        agentAddress: instance.address,
        from: SCHEDULER_ADDRESS,
        messageId: `<${mailId}@system>`,
        date: new Date(),
        content: 'sync',
        sessionId: instance.sessionId,
        tenantId: instance.tenantId,
        cryptoProvider,
      });
      log.debug('Oat scheduler: trigger sent', { instanceId: instance.id });
    } catch (err) {
      log.error('Oat scheduler: failed to trigger instance', {
        instanceId: instance.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}

/**
 * Start the Oat scheduler loop. Sends a sync trigger to every running Oat
 * instance every 60 s. Returns a cleanup function that stops the loop.
 */
export function startOatScheduler(db: OatSchedulerDB, sessionService: SessionService): () => void {
  log.info('Starting Oat scheduler', { intervalMs: POLL_INTERVAL_MS });

  void triggerOatInstances(db, sessionService);
  const timer = setInterval(() => void triggerOatInstances(db, sessionService), POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    log.info('Oat scheduler stopped');
  };
}
