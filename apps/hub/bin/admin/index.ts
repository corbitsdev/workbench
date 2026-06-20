/* eslint-disable no-console */

// GTM Workbench admin CLI — one menu-driven entrypoint for operators.
//
//   auth → tenant select → resource → action → inputs → execute
//
// Everything the CLI can do is discovered from the hub's live /openapi.json, so
// it stays in lockstep with the API surface — no hard-coded endpoint list. Pick
// the environment by env file: `bun run admin:staging` / `admin:production`
// load .env.staging / .env.production (HUB_URL + admin credentials); `bun run
// admin` uses the local .env.

import { api, env, makeFail, makeLogger, signIn, type CookieJar } from '../_lib';
import { createHubClient, type HubClient } from './client';
import { groupByTag, operationInputs, type ResourceGroup } from './menu';
import { LOCAL_ACTIONS, runLocalAction } from './local';
import { ask, confirm, selectOne } from './prompts';

const LOCAL_GROUP = 'Local actions (build, seed, push)';

const log = makeLogger('admin');
const fail = makeFail('admin');

const BASE = env('HUB_URL') ?? env('BETTER_AUTH_BASE_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

interface TenantChoice {
  tenantId: string;
  slug: string;
  name: string;
}

async function listTenants(cookies: CookieJar): Promise<TenantChoice[]> {
  const res = await api(BASE, 'GET', '/api/me/principals', undefined, cookies);
  if (res.status !== 200) fail('list principals', res.status, res.data);
  const rows = (res.data as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  const out: TenantChoice[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { tenantId, tenantSlug, tenantName } = row as Record<string, unknown>;
    if (typeof tenantId !== 'string' || typeof tenantSlug !== 'string') continue;
    out.push({
      tenantId,
      slug: tenantSlug,
      name: typeof tenantName === 'string' ? tenantName : tenantSlug,
    });
  }
  return out;
}

// Prefill the selected tenant into the conventional tenant params so picking a
// tenant up front drives the action; the operator can still override.
function defaultForInput(name: string, kind: string, tenant: TenantChoice): string | undefined {
  if (kind === 'query' || kind === 'path') {
    if (name === 'tenantId') return tenant.tenantId;
    if (name === 'tenant') return tenant.slug;
  }
  return undefined;
}

function collectInputs(
  client: HubClient,
  group: ResourceGroup,
  opIndex: number,
  tenant: TenantChoice
) {
  const op = group.operations[opIndex];
  if (!op) return null;
  const inputs = operationInputs(client.spec, op.method, op.path);

  const pathParams: Record<string, string> = {};
  const query: Record<string, string | undefined> = {};
  const body: Record<string, unknown> = {};

  for (const input of inputs) {
    const prefill = defaultForInput(input.name, input.kind, tenant);
    const label = `${input.name}${input.required ? '' : ' (optional)'}${
      input.description ? ` — ${input.description}` : ''
    }${prefill !== undefined ? ` [${prefill}]` : ''}`;
    const raw = ask(`${label}:`);
    const value = raw === null || raw.trim() === '' ? prefill : raw.trim();

    if (value === undefined || value === '') {
      if (input.required) {
        log(`skipped required input "${input.name}"; aborting this action`);
        return null;
      }
      continue;
    }

    if (input.kind === 'path') pathParams[input.name] = value;
    else if (input.kind === 'query') query[input.name] = value;
    else body[input.name] = coerceBodyValue(value);
  }

  const hasBody = Object.keys(body).length > 0;
  return {
    op,
    pathParams,
    query,
    ...(hasBody ? { body } : {}),
  };
}

// Body values arrive as strings; parse JSON-looking ones (objects, arrays,
// numbers, booleans) so structured fields aren't sent as strings.
function coerceBodyValue(value: string): unknown {
  const first = value[0];
  if (
    first === '{' ||
    first === '[' ||
    /^-?\d/.test(value) ||
    value === 'true' ||
    value === 'false' ||
    value === 'null'
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function runLocalActions(tenant: TenantChoice): Promise<void> {
  const action = selectOne(LOCAL_GROUP, LOCAL_ACTIONS, (a) => a.label);
  if (!action) return;

  let extraArgs: string[] = [];
  if (action.prompt) {
    const raw = ask(`${action.prompt.text}:`);
    const value = raw === null ? '' : raw.trim();
    if (value) extraArgs = [action.prompt.flag, value];
  }
  if (
    !confirm(
      `Run "${action.label}"${action.tenantAware ? ` against tenant "${tenant.slug}"` : ''}?`
    )
  ) {
    log('cancelled');
    return;
  }
  const code = await runLocalAction(action, tenant.slug, extraArgs);
  log(`"${action.label}" exited with code ${code}`);
}

async function runOnce(client: HubClient, tenant: TenantChoice): Promise<void> {
  const specGroups = groupByTag(client.operations());
  const resources: { label: string; group: ResourceGroup | null }[] = [
    { label: `${LOCAL_GROUP} (${LOCAL_ACTIONS.length})`, group: null },
    ...specGroups.map((g) => ({ label: `${g.tag} (${g.operations.length})`, group: g })),
  ];
  const chosen = selectOne('Resource:', resources, (r) => r.label);
  if (!chosen) return;
  if (chosen.group === null) {
    await runLocalActions(tenant);
    return;
  }
  const group = chosen.group;

  const op = selectOne(
    `${group.tag} — action:`,
    group.operations,
    (o) => `${o.method.toUpperCase()} ${o.path}${o.summary ? ` — ${o.summary}` : ''}`
  );
  if (!op) return;

  const opIndex = group.operations.indexOf(op);
  const collected = collectInputs(client, group, opIndex, tenant);
  if (!collected) return;

  if (
    op.method !== 'get' &&
    !confirm(`${op.method.toUpperCase()} ${op.path} against tenant "${tenant.slug}"?`)
  ) {
    log('cancelled');
    return;
  }

  const result = await client.call(op.method, op.path, {
    pathParams: collected.pathParams,
    query: collected.query,
    ...(collected.body !== undefined ? { body: collected.body } : {}),
  });

  const validNote = result.valid === false ? ' (response did NOT match the spec schema)' : '';
  log(`${result.status}${validNote}`);
  console.log(JSON.stringify(result.data, null, 2));
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    fail('startup', 0, 'admin CLI is interactive; run it in a terminal');
  }

  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);
  log(`Connected to ${BASE}`);

  const client = await createHubClient({ baseUrl: BASE, cookies });
  log(`Loaded API spec: ${client.spec.api.title} (${client.operations().length} operations)`);

  const tenants = await listTenants(cookies);
  if (tenants.length === 0) fail('tenants', 0, 'caller is not a principal of any tenant');

  const tenant = selectOne('Tenant:', tenants, (t) => `${t.name} [${t.slug}]`);
  if (!tenant) {
    log('no tenant selected; exiting');
    return;
  }
  log(`Active tenant: ${tenant.name} [${tenant.slug}]`);

  let again = true;
  while (again) {
    await runOnce(client, tenant);
    again = confirm('\nAnother action?');
  }
  log('done');
}

await main();
