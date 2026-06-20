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

import {
  api,
  env,
  makeFail,
  makeLogger,
  signIn,
  type CookieJar,
} from "../_lib";
import { createHubClient, type HubClient } from "./client";
import {
  extractItems,
  findListOperation,
  groupByTag,
  itemLabel,
  operationInputs,
  type OperationInput,
  type ResourceGroup,
} from "./menu";
import { localGroups, runLocalAction, type LocalAction } from "./local";
import { ask, confirm, selectOne } from "./prompts";

const log = makeLogger("admin");
const fail = makeFail("admin");

const BASE =
  env("HUB_URL") ?? env("BETTER_AUTH_BASE_URL", "http://localhost:4000");
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com");
const PASSWORD = env("SUPERADMIN_PASS", "password123");
const SESSION_TOKEN = process.env["SESSION_TOKEN"];

interface TenantChoice {
  tenantId: string;
  slug: string;
  name: string;
}

async function listTenants(cookies: CookieJar): Promise<TenantChoice[]> {
  const res = await api(BASE, "GET", "/api/me/principals", undefined, cookies);
  if (res.status !== 200) fail("list principals", res.status, res.data);
  const rows = (res.data as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  const out: TenantChoice[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { tenantId, tenantSlug, tenantName } = row as Record<string, unknown>;
    if (typeof tenantId !== "string" || typeof tenantSlug !== "string")
      continue;
    out.push({
      tenantId,
      slug: tenantSlug,
      name: typeof tenantName === "string" ? tenantName : tenantSlug,
    });
  }
  return out;
}

// Prefill the selected tenant into the conventional tenant params so picking a
// tenant up front drives the action; the operator can still override.
function defaultForInput(
  name: string,
  kind: string,
  tenant: TenantChoice,
): string | undefined {
  if (kind === "query" || kind === "path") {
    if (name === "tenantId") return tenant.tenantId;
    if (name === "tenant") return tenant.slug;
  }
  return undefined;
}

// Sentinel a guided prompt returns when the operator chooses to leave an
// optional input unset (distinct from "aborted").
const SKIP = Symbol("skip");

// List one page at a time from a reference resource and let the operator pick a
// row by name, paging with "Load more…" until they choose or skip. Returns the
// selected id, SKIP (optional + skipped), or null (aborted / nothing to pick).
async function pickReference(
  client: HubClient,
  tenant: TenantChoice,
  input: OperationInput,
): Promise<string | typeof SKIP | null> {
  const tag = input.reference;
  if (tag === undefined) return null;
  const listOp = findListOperation(client.operations(), tag);
  if (!listOp) return null;

  let cursor: string | undefined;
  for (;;) {
    const query: Record<string, string | undefined> = { limit: "25" };
    if (cursor !== undefined) query["cursor"] = cursor;
    const res = await client.call(listOp.method, listOp.path, {
      pathParams: { tenantId: tenant.tenantId },
      query,
    });
    if (res.status !== 200) {
      log(`could not list ${tag} (${res.status}); enter ${input.name} by hand`);
      return null;
    }

    const { items, nextCursor } = extractItems(res.data);
    const rows = items
      .map((item) => itemLabel(item))
      .filter((r) => r.id !== undefined);

    type Choice = { label: string; value: string | typeof SKIP | "more" };
    const choices: Choice[] = rows.map((r) => ({
      label: r.label,
      value: r.id as string,
    }));
    if (nextCursor !== undefined)
      choices.push({ label: "Load more…", value: "more" });
    if (!input.required) choices.push({ label: "(leave unset)", value: SKIP });

    if (choices.length === 0) {
      log(`no ${tag} found`);
      return input.required ? null : SKIP;
    }

    const chosen = selectOne(
      `${input.name} — pick a ${singular(tag)}:`,
      choices,
      (c) => c.label,
    );
    if (!chosen) return input.required ? null : SKIP;
    if (chosen.value === "more") {
      cursor = nextCursor;
      continue;
    }
    return chosen.value;
  }
}

function singular(tag: string): string {
  const lower = tag.toLowerCase();
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

// Guided prompt for a single operation input. Uses the spec facts to choose the
// right control: a reference list picker, an enum picker, a yes/no toggle, or
// (last resort) free text — so a caller who knows nothing is never asked to type
// a value they cannot know. Returns the string value, SKIP, or null (abort).
async function promptInput(
  client: HubClient,
  tenant: TenantChoice,
  input: OperationInput,
  prefill: string | undefined,
): Promise<string | typeof SKIP | null> {
  const opt = input.required ? "" : " (optional)";
  const desc = input.description ? ` — ${input.description}` : "";

  if (input.reference !== undefined && prefill === undefined) {
    const picked = await pickReference(client, tenant, input);
    if (picked !== null) return picked;
    // Fall through to free text if the list could not be fetched.
  }

  if (input.enumValues && input.enumValues.length > 0) {
    const choices = [...input.enumValues];
    const chosen = selectOne(`${input.name}${opt}${desc}:`, choices, (v) => v);
    if (chosen !== null) return chosen;
    return input.required ? null : SKIP;
  }

  if (input.valueType === "boolean") {
    const chosen = selectOne(
      `${input.name}${opt}${desc}:`,
      ["true", "false"],
      (v) => v,
    );
    if (chosen !== null) return chosen;
    return input.required ? null : SKIP;
  }

  const hint = prefill !== undefined ? ` [${prefill}]` : "";
  const raw = ask(`${input.name}${opt}${desc}${hint}:`);
  const value = raw === null || raw.trim() === "" ? prefill : raw.trim();
  if (value === undefined || value === "") return input.required ? null : SKIP;
  return value;
}

async function collectInputs(
  client: HubClient,
  group: ResourceGroup,
  opIndex: number,
  tenant: TenantChoice,
) {
  const op = group.operations[opIndex];
  if (!op) return null;
  const inputs = operationInputs(client.spec, op.method, op.path);

  const pathParams: Record<string, string> = {};
  const query: Record<string, string | undefined> = {};
  const body: Record<string, unknown> = {};

  for (const input of inputs) {
    const prefill = defaultForInput(input.name, input.kind, tenant);
    const value = await promptInput(client, tenant, input, prefill);

    if (value === null) {
      log(`no value for required input "${input.name}"; aborting this action`);
      return null;
    }
    if (value === SKIP) continue;

    if (input.kind === "path") pathParams[input.name] = value;
    else if (input.kind === "query") query[input.name] = value;
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
    first === "{" ||
    first === "[" ||
    /^-?\d/.test(value) ||
    value === "true" ||
    value === "false" ||
    value === "null"
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function runSingleLocalAction(
  action: LocalAction,
  tenant: TenantChoice,
): Promise<void> {
  let extraArgs: string[] = [];
  if (action.choices) {
    const values = action.choices.discover();
    if (values.length === 0) {
      log(
        `no ${action.choices.text.toLowerCase()} options found; aborting this action`,
      );
      return;
    }
    const chosen = selectOne(`${action.choices.text}:`, values, (v) => v);
    if (!chosen) {
      log("nothing selected; aborting this action");
      return;
    }
    extraArgs = [action.choices.flag, chosen];
  } else if (action.prompt) {
    const raw = ask(`${action.prompt.text}:`);
    const value = raw === null ? "" : raw.trim();
    if (value) extraArgs = [action.prompt.flag, value];
  }
  if (
    !confirm(
      `Run "${action.label}"${action.tenantAware ? ` against tenant "${tenant.slug}"` : ""}?`,
    )
  ) {
    log("cancelled");
    return;
  }
  const code = await runLocalAction(action, tenant.slug, extraArgs);
  log(`"${action.label}" exited with code ${code}`);
}

async function runSpecOperation(
  client: HubClient,
  group: ResourceGroup,
  op: ResourceGroup["operations"][number],
  tenant: TenantChoice,
): Promise<void> {
  const opIndex = group.operations.indexOf(op);
  const collected = await collectInputs(client, group, opIndex, tenant);
  if (!collected) return;

  if (
    op.method !== "get" &&
    !confirm(
      `${op.method.toUpperCase()} ${op.path} against tenant "${tenant.slug}"?`,
    )
  ) {
    log("cancelled");
    return;
  }

  // GET list responses page through `nextCursor`; everything else prints once.
  let cursor: string | undefined;
  for (;;) {
    const query = { ...collected.query };
    if (cursor !== undefined) query["cursor"] = cursor;
    const result = await client.call(op.method, op.path, {
      pathParams: collected.pathParams,
      query,
      ...(collected.body !== undefined ? { body: collected.body } : {}),
    });

    const validNote =
      result.valid === false ? " (response did NOT match the spec schema)" : "";
    log(`${result.status}${validNote}`);
    console.log(JSON.stringify(result.data, null, 2));

    if (op.method !== "get" || result.status !== 200) return;
    const { nextCursor } = extractItems(result.data);
    if (nextCursor === undefined || !confirm("Load next page?")) return;
    cursor = nextCursor;
  }
}

// A resource in the operator menu: local actions and spec operations merged
// under one display name. The local "Workflows" push action and the spec
// "Workflows" run routes collapse into a single resource so there is one
// obvious place per domain — no two same-named groups doing different things.
interface MergedResource {
  name: string;
  localActions: LocalAction[];
  specGroup: ResourceGroup | null;
}

function mergeResources(
  local: { group: string; actions: LocalAction[] }[],
  specGroups: ResourceGroup[],
): MergedResource[] {
  const order: string[] = [];
  const byName = new Map<string, MergedResource>();
  const ensure = (name: string): MergedResource => {
    const existing = byName.get(name);
    if (existing) return existing;
    const created: MergedResource = { name, localActions: [], specGroup: null };
    byName.set(name, created);
    order.push(name);
    return created;
  };
  for (const g of local) ensure(g.group).localActions.push(...g.actions);
  for (const g of specGroups) ensure(g.tag).specGroup = g;
  return order.map((name) => byName.get(name) as MergedResource);
}

async function runOnce(client: HubClient, tenant: TenantChoice): Promise<void> {
  const specGroups = groupByTag(client.operations());
  const resources = mergeResources(localGroups(), specGroups);

  const chosen = selectOne(
    "Resource:",
    resources,
    (r) =>
      `${r.name} (${r.localActions.length + (r.specGroup?.operations.length ?? 0)})`,
  );
  if (!chosen) return;

  // One combined action list: friendly local actions first, then the spec's
  // HTTP operations for the same resource.
  type Action =
    | { kind: "local"; action: LocalAction; label: string }
    | {
        kind: "spec";
        op: ResourceGroup["operations"][number];
        label: string;
      };
  const actions: Action[] = [
    ...chosen.localActions.map((action) => ({
      kind: "local" as const,
      action,
      label: action.label,
    })),
    ...(chosen.specGroup?.operations ?? []).map((op) => ({
      kind: "spec" as const,
      op,
      label: `${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary}` : ""}`,
    })),
  ];

  const action = selectOne(`${chosen.name} — action:`, actions, (a) => a.label);
  if (!action) return;

  if (action.kind === "local") {
    await runSingleLocalAction(action.action, tenant);
    return;
  }
  if (chosen.specGroup) {
    await runSpecOperation(client, chosen.specGroup, action.op, tenant);
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    fail("startup", 0, "admin CLI is interactive; run it in a terminal");
  }

  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);
  log(`Connected to ${BASE}`);

  const client = await createHubClient({ baseUrl: BASE, cookies });
  log(
    `Loaded API spec: ${client.spec.api.title} (${client.operations().length} operations)`,
  );

  const tenants = await listTenants(cookies);
  if (tenants.length === 0)
    fail("tenants", 0, "caller is not a principal of any tenant");

  const tenant = selectOne("Tenant:", tenants, (t) => `${t.name} [${t.slug}]`);
  if (!tenant) {
    log("no tenant selected; exiting");
    return;
  }
  log(`Active tenant: ${tenant.name} [${tenant.slug}]`);

  let again = true;
  while (again) {
    await runOnce(client, tenant);
    again = confirm("\nAnother action?");
  }
  log("done");
}

await main();
