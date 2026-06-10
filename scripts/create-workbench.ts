/**
 * Creates a workbench via the hub API.
 *
 * Usage:
 *   bun run scripts/create-workbench.ts --name "Acme Corp" --url http://localhost:3000 --cookie "<session-cookie>"
 *
 * The session cookie can be copied from your browser's DevTools (the
 * `better-auth.session_token` cookie, or your hub's equivalent session cookie).
 *
 * Required env vars (alternative to flags):
 *   HUB_URL      — base URL of the hub (default: http://localhost:3000)
 *   HUB_COOKIE   — full cookie header value for an authenticated session
 */

function requireArg(args: string[], flag: string, envVar: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  const env = process.env[envVar];
  if (env) return env;
  throw new Error(`Missing required argument: ${flag} (or env var ${envVar})`);
}

function optionalArg(args: string[], flag: string, envVar: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  return process.env[envVar] ?? fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
create-workbench — create a workbench via the hub API

Usage:
  bun run scripts/create-workbench.ts --name "Acme Corp" [--url http://localhost:3000] [--cookie "<value>"]

Flags:
  --name    Workbench display name (required)
  --url     Hub base URL (default: http://localhost:3000 or HUB_URL env)
  --cookie  Session cookie header value (or HUB_COOKIE env)
  --help    Show this message
`);
    process.exit(0);
  }

  const name = requireArg(args, '--name', 'WORKBENCH_NAME');
  const url = optionalArg(args, '--url', 'HUB_URL', 'http://localhost:3000');
  const cookie = requireArg(args, '--cookie', 'HUB_COOKIE');

  const endpoint = `${url.replace(/\/$/, '')}/api/v1/workbenches`;

  console.log(`Creating workbench "${name}" via ${endpoint} ...`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ name }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    console.error(`Failed: ${message}`);
    process.exit(1);
  }

  const wb = body as { id: string; name: string; slug: string; tenantId: string };
  console.log(`Workbench created:`);
  console.log(`  name:     ${wb.name}`);
  console.log(`  slug:     ${wb.slug}`);
  console.log(`  tenantId: ${wb.tenantId}`);
  console.log(`  id:       ${wb.id}`);
}

await main();
