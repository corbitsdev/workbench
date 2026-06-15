import { sign as nodeSign } from 'node:crypto';
import { setupObservability } from '@workbench/sentry';
import { createInMemoryTransport } from '@intx/mail-memory';
import {
  createNodeCrypto,
  generateKeyPair,
  importPrivateKeyBytes,
  verifySSHSignature,
} from '@intx/crypto-node';
import { createSidecarOrchestrator } from '@intx/hub-agent';
import { createDefaultHarnessBuilder, wsUrlToHttp } from './default-harness';
import { resolveSidecarHeartbeat } from './config';

await setupObservability({ dev: process.env.NODE_ENV !== 'production' });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const heartbeat = resolveSidecarHeartbeat(process.env);

const orchestrator = createSidecarOrchestrator({
  hubURL: requireEnv('HUB_WS_URL'),
  sidecarId: requireEnv('SIDECAR_ID'),
  token: requireEnv('SIDECAR_TOKEN'),
  dataDir: requireEnv('SIDECAR_DATA_DIR'),
  pingIntervalMs: heartbeat.pingIntervalMs,
  reconnectDelayMs: heartbeat.reconnectDelayMs,
  transport: createInMemoryTransport(),
  buildHarness: createDefaultHarnessBuilder({
    hubHttpUrl: wsUrlToHttp(requireEnv('HUB_WS_URL')),
    sidecarToken: requireEnv('SIDECAR_TOKEN'),
  }),
  createAgentCrypto: createNodeCrypto,
  cryptoOps: {
    generateKeyPair,
    signEd25519(privateKey, payload) {
      const key = importPrivateKeyBytes(privateKey);
      return new Uint8Array(nodeSign(null, payload, key));
    },
    verifySSHSig: verifySSHSignature,
  },
});

orchestrator.start();
