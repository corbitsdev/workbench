import { getLogger } from '@intx/log';
import { parseEncryptionKeys } from '@workbench/hub-crypto';

const log = getLogger(['api', 'config']);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const isDev = process.env['NODE_ENV'] !== 'production';

  const corsOrigins = parseOrigins(optionalEnv('SUPPORTED_CORS_ORIGINS'));

  if (!isDev && corsOrigins.length === 0) {
    throw new Error(
      'SUPPORTED_CORS_ORIGINS must be set in production (comma-separated list of allowed origins)'
    );
  }

  const googleClientId = optionalEnv('GOOGLE_CLIENT_ID');
  const googleClientSecret = optionalEnv('GOOGLE_CLIENT_SECRET');

  if (googleClientId && !googleClientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set');
  }
  if (googleClientSecret && !googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set');
  }

  const config = {
    isDev,
    port: requireEnv('PORT'),
    sidecarToken: requireEnv('SIDECAR_TOKEN'),
    auth: {
      secret: requireEnv('BETTER_AUTH_SECRET'),
      baseUrl: requireEnv('BETTER_AUTH_BASE_URL'),
    },
    cors: {
      origins: corsOrigins,
      isCrossOrigin: corsOrigins.length > 0,
    },
    llm: {
      apiKey: requireEnv('OPENAI_COMPATIBLE_API_KEY'),
      model: requireEnv('OPENAI_COMPATIBLE_MODEL'),
      baseUrl: optionalEnv('OPENAI_COMPATIBLE_BASE_URL'),
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      allowedDomains: parseOrigins(optionalEnv('GOOGLE_ALLOWED_DOMAINS')),
    },
    granola: {
      apiKey: optionalEnv('GRANOLA_API_KEY'),
      baseUrl: 'https://public-api.granola.ai/v1',
    },
    hub: {
      dataDir: requireEnv('HUB_DATA_DIR'),
      signingKeys: requireEnv('HUB_SIGNING_KEYS'),
    },
    credentialKeys: parseEncryptionKeys(requireEnv('CREDENTIAL_ENCRYPTION_KEYS')),
  };

  log.info('Configuration loaded', {
    isDev,
    port: config.port,
    corsOrigins: config.cors.origins,
    llmModel: config.llm.model,
    googleAuthEnabled: Boolean(config.google.clientId),
  });

  _config = config;
  return config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded — call loadConfig() at startup before use');
  return _config;
}

let _config: Config | undefined;

export type Config = ReturnType<typeof loadConfig>;
