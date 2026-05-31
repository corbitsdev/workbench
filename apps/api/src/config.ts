import { getLogger } from '@intx/log';

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

  const config = {
    isDev,
    port: requireEnv('PORT'),
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
      clientId: optionalEnv('GOOGLE_CLIENT_ID'),
      clientSecret: optionalEnv('GOOGLE_CLIENT_SECRET'),
      allowedDomains: parseOrigins(optionalEnv('GOOGLE_ALLOWED_DOMAINS')),
    },
  };

  log.info('Configuration loaded', {
    isDev,
    port: config.port,
    corsOrigins: config.cors.origins,
    llmModel: config.llm.model,
    googleAuthEnabled: Boolean(config.google.clientId),
  });

  return config;
}

export type Config = ReturnType<typeof loadConfig>;
