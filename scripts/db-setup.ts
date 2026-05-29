/**
 * Forward-only database migration runner.
 *
 * Uses drizzle-orm's built-in migrator for Interchange migrations,
 * then applies GTM custom migrations via raw SQL with
 * idempotent guards (CREATE TABLE IF NOT EXISTS, ADD CONSTRAINT
 * IF NOT EXISTS). This avoids the journal-table collision that
 * occurs when two separate migration folders share the same
 * drizzle.__drizzle_migrations schema.
 */

interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseDatabaseUrl(url: string): DBConfig {
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
  const port = Number(parsed.port || 5432);
  const user = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const database = parsed.pathname.replace(/^\//, '');

  if (!user) throw new Error(`Invalid DATABASE_URL: username is missing`);
  if (!password) throw new Error(`Invalid DATABASE_URL: password is missing`);
  if (!database) throw new Error(`Invalid DATABASE_URL: database name is missing`);

  const ssl =
    parsed.searchParams.get('sslmode') === 'require' ||
    parsed.searchParams.get('sslmode') === 'prefer' ||
    parsed.searchParams.get('ssl') === 'true' ||
    process.env['DB_SSL'] === 'true';

  return { host, port, user, password, database, ssl };
}

function resolveDBConfig(): DBConfig {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl) {
    try {
      const config = parseDatabaseUrl(databaseUrl);
      console.log(
        `[db-config] Using DATABASE_URL (host=${config.host}, port=${config.port}, db=${config.database})`
      );
      return config;
    } catch (err) {
      if (err instanceof Error) {
        console.error(`[db-config] DATABASE_URL failed: ${err.message}`);
      }
    }
  }

  return {
    host: requireEnv('DB_HOST'),
    port: Number(process.env['DB_PORT'] ?? 5432),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    ssl: process.env['DB_SSL'] === 'true',
  };
}

const DB = resolveDBConfig();

async function waitForPostgres(maxRetries = 10, delayMs = 1000): Promise<void> {
  const postgres = await import('postgres');

  console.log(`Waiting for Postgres at ${DB.host}:${DB.port} (user: ${DB.user})...`);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const sql = postgres.default({
        host: DB.host,
        port: DB.port,
        user: DB.user,
        password: DB.password,
        database: 'postgres',
        ssl: DB.ssl,
        max: 1,
        connect_timeout: 2,
      });
      await sql`SELECT 1`;
      await sql.end();
      console.log('Postgres is ready.');
      return;
    } catch {
      if (i < maxRetries - 1) {
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(
    `Could not connect to Postgres at ${DB.host}:${DB.port} after ${maxRetries} attempts. Is the container running and the port mapped?`
  );
}

async function checkDatabase(): Promise<void> {
  const postgres = await import('postgres');
  const sql = postgres.default({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: 'postgres',
    ssl: DB.ssl,
    max: 1,
  });

  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${DB.database}`;
    if (rows.length === 0) {
      console.log(`Creating database "${DB.database}"...`);
      await sql.unsafe(`CREATE DATABASE "${DB.database.replace(/"/g, '""')}"`);
      console.log(`Database "${DB.database}" created.`);
    } else {
      console.log(`Database "${DB.database}" already exists.`);
    }
  } finally {
    await sql.end();
  }
}

async function runInterchangeMigrations(client: import('postgres').Sql<{}>): Promise<void> {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');

  const db = drizzle(client);

  console.log('\n  → Applying Interchange migrations...');
  const start = Date.now();
  await migrate(db, {
    migrationsFolder: 'interchange/packages/db/migrations',
  });
  console.log(`  ✅ Interchange migrations applied in ${Date.now() - start}ms`);
}

async function runCustomMigrations(client: import('postgres').Sql<{}>): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const migrationsDir = 'apps/api/migrations';

  if (!fs.existsSync(migrationsDir)) {
    console.log('\n  → No custom migrations found.');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('\n  → No custom migrations found.');
    return;
  }

  console.log(`\n  → Applying ${files.length} custom migration(s)...`);
  const start = Date.now();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      // CREATE TABLE — skip if table already exists
      const createMatch = stmt.match(/CREATE TABLE "([^"]+)"/);
      if (createMatch) {
        const tableName = createMatch[1];
        const [{ exists }] = await client`
          SELECT EXISTS(
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'public' AND tablename = ${tableName}
          ) as exists
        `;
        if (exists) {
          console.log(`    (skip) Table "${tableName}" already exists`);
          continue;
        }
      }

      // ALTER TABLE ADD CONSTRAINT — skip if constraint already exists
      const alterMatch = stmt.match(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/);
      if (alterMatch) {
        const tableName = alterMatch[1];
        const constraintName = alterMatch[2];
        const [{ exists }] = await client`
          SELECT EXISTS(
            SELECT 1 FROM pg_constraint
            WHERE conname = ${constraintName}
              AND conrelid = ${tableName}::regclass
          ) as exists
        `;
        if (exists) {
          console.log(`    (skip) Constraint "${constraintName}" already exists`);
          continue;
        }
      }

      await client.unsafe(stmt);
    }
  }

  console.log(`  ✅ Custom migrations applied in ${Date.now() - start}ms`);
}

async function runMigrations(): Promise<void> {
  const postgres = await import('postgres');

  const client = postgres.default({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: DB.database,
    ssl: DB.ssl,
    max: 1,
  });

  console.log('Running forward-only migrations...');

  await runInterchangeMigrations(client);
  await runCustomMigrations(client);

  await client.end();
}

async function main(): Promise<void> {
  console.log('=== GTM Workbench DB Setup ===');

  try {
    await waitForPostgres();
    await checkDatabase();
    await runMigrations();
    console.log('\n✅ DB setup complete.');
  } catch (err) {
    console.error('\n❌ DB setup failed:');
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
