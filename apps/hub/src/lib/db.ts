export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  max?: number;
}

export function parseDatabaseUrl(url: string): DatabaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid DATABASE_URL: could not parse as URL`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Invalid DATABASE_URL: expected postgres:// or postgresql:// scheme, got ${parsed.protocol}`
    );
  }

  const host = parsed.hostname || 'localhost';
  const port = Number(parsed.port || 5433);
  const user = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const database = parsed.pathname.replace(/^\//, '');

  if (!user) throw new Error(`Invalid DATABASE_URL: username is missing`);
  if (!password) throw new Error(`Invalid DATABASE_URL: password is missing`);
  if (!database) throw new Error(`Invalid DATABASE_URL: database name is missing`);

  const ssl =
    parsed.searchParams.get('sslmode') === 'require' ||
    parsed.searchParams.get('sslmode') === 'prefer' ||
    parsed.searchParams.get('ssl') === 'true';

  return { host, port, user, password, database, ssl };
}

export function resolveDatabaseConfig(): DatabaseConfig {
  const databaseUrl = process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error(
      'Missing required environment variable: DATABASE_URL. ' +
        'Example: postgres://workbench:workbench-dev-password@localhost:5433/workbench'
    );
  }

  return parseDatabaseUrl(databaseUrl);
}
