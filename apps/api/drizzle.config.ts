import { defineConfig } from 'drizzle-kit';

function parseDatabaseUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Invalid DATABASE_URL: expected postgres:// or postgresql:// scheme, got ${parsed.protocol}`
    );
  }
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || '5433'),
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'Missing required environment variable: DATABASE_URL. ' +
      'Example: postgres://workbench:workbench-dev-password@localhost:5433/workbench'
  );
}

const dbCredentials = parseDatabaseUrl(databaseUrl);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials,
});
