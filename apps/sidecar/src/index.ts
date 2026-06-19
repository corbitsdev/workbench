import { sign as nodeSign } from 'node:crypto';
import { setupObservability } from '@workbench/sentry';
import { createInMemoryTransport } from '@intx/mail-memory';
import {
  createNodeCrypto,
  generateKeyPair,
  importPrivateKeyBytes,
  verifySSHSignature,
} from '@intx/crypto-node';
import { installGeminiThoughtSignaturePatch } from './gemini-thought-signature-patch';
import { createSidecarOrchestrator } from '@intx/hub-agent';
import { createDefaultHarnessBuilder, wsUrlToHttp } from './default-harness';
import { resolveSidecarHeartbeat, resolveToolPackageCache } from './config';

await setupObservability({ dev: process.env.NODE_ENV !== 'production' });

// Install the google-genai thoughtSignature workaround before any inference
// happens. This wraps the registered adapter to strip orphan
// `thoughtSignature` parts that Gemini 3.x models emit, which the upstream
// parser cannot handle (BD-394). Remove once the vendored Interchange commit
// contains the fix.
installGeminiThoughtSignaturePatch();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const heartbeat = resolveSidecarHeartbeat(process.env);
const dataDir = requireEnv('SIDECAR_DATA_DIR');
const toolPackageCache = resolveToolPackageCache(process.env, dataDir);

const orchestrator = createSidecarOrchestrator({
  hubURL: requireEnv('HUB_WS_URL'),
  sidecarId: requireEnv('SIDECAR_ID'),
  token: requireEnv('SIDECAR_TOKEN'),
  dataDir,
  pingIntervalMs: heartbeat.pingIntervalMs,
  reconnectDelayMs: heartbeat.reconnectDelayMs,
  transport: createInMemoryTransport(),
  buildHarness: createDefaultHarnessBuilder({
    hubHttpUrl: wsUrlToHttp(requireEnv('HUB_WS_URL')),
    sidecarToken: requireEnv('SIDECAR_TOKEN'),
    cacheRoot: toolPackageCache.cacheRoot,
    cacheMaxBytes: toolPackageCache.cacheMaxBytes,
    registryMaxTarballBytes: toolPackageCache.registryMaxTarballBytes,
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
