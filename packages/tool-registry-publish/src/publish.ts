// Publishes the packed `@corbits/*-tools` tarballs into a tenant's
// `corbits-tools` package-registry asset over the hub's native REST
// asset routes (find-or-create the asset, then `PUT` each tarball) —
// the only supported write path for a non-hub principal
// (`vendor/intx/hub-sessions/src/package-registry-kind.ts`'s
// `packageRegistryAuthorize`). Idempotent: re-running overwrites
// same-name tarball entries and reuses an existing registry asset.

import { AssetResponse, AssetWithOriginResponse } from "@intx/types";
import { type, type Type } from "arktype";
import { packToolPackageTarball, type PackedTarball } from "./pack";
import { CORBITS_TOOL_PACKAGE_DIRS, CORBITS_TOOLS_REGISTRY } from "./registry";

export type ApiResult = { status: number; data: unknown; cookies: string[] };

/** Structurally compatible with `@workbench/hub-client`'s `ApiCall` — declared locally so this package never depends on hub-client, which depends on this one. */
export type ApiCall = (
  method: string,
  path: string,
  body?: unknown,
  cookies?: string[],
) => Promise<ApiResult>;

const TarballPutResponse = type({ commit: "string", integrity: "string" });

export type PublishSummary = {
  filename: string;
  commit: string;
  integrity: string;
};

function parseSchema<T extends Type>(
  schema: T,
  data: unknown,
  label: string,
): T["infer"] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(
      `publishCorbitsToolsRegistry: validation failed for ${label}: ${result.summary}`,
    );
  }
  return result;
}

async function listRegistryAsset(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string | undefined> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`,
    undefined,
    cookies,
  );
  if (listed.status !== 200) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to list assets: ${String(listed.status)}`,
    );
  }
  const rows = parseSchema(
    AssetWithOriginResponse.array(),
    listed.data,
    "list assets response",
  );
  return rows.find((row) => row.name === CORBITS_TOOLS_REGISTRY)?.id;
}

/**
 * Create-first, list-on-conflict — the same ensure-then-create
 * tolerance `seedTenant`'s own `ensureWorkflowAsset` uses, so two
 * overlapping seed runs for the same tenant never both fail on a
 * name collision the substrate itself reports as a 409.
 */
async function ensureRegistryAsset(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string> {
  const existing = await listRegistryAsset(api, cookies, tenantId);
  if (existing !== undefined) return existing;

  const created = await api(
    "POST",
    `/api/tenants/${tenantId}/assets`,
    { kind: "package-registry", name: CORBITS_TOOLS_REGISTRY },
    cookies,
  );
  if (created.status === 201) {
    return parseSchema(AssetResponse, created.data, "create asset response").id;
  }
  if (created.status !== 409) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to create the ${CORBITS_TOOLS_REGISTRY} asset: ${String(created.status)}`,
    );
  }

  const afterConflict = await listRegistryAsset(api, cookies, tenantId);
  if (afterConflict === undefined) {
    throw new Error(
      `publishCorbitsToolsRegistry: the ${CORBITS_TOOLS_REGISTRY} asset reported a name conflict but is not listable on the tenant`,
    );
  }
  return afterConflict;
}

async function putTarball(
  hubUrl: string,
  cookies: string[],
  tenantId: string,
  assetId: string,
  tarball: PackedTarball,
  fetchImpl: typeof fetch,
): Promise<PublishSummary> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");
  const response = await fetchImpl(
    `${hubUrl}/api/tenants/${tenantId}/assets/${assetId}/tarballs/${tarball.filename}`,
    { method: "PUT", headers, body: tarball.bytes, redirect: "manual" },
  );
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(
      `publishCorbitsToolsRegistry: upload failed for ${tarball.filename}: ${String(response.status)} ${text}`,
    );
  }
  const parsed = parseSchema(
    TarballPutResponse,
    await response.json(),
    `PUT ${tarball.filename}`,
  );
  return { filename: tarball.filename, ...parsed };
}

export type PublishCorbitsToolsRegistryArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * Ensures the tenant's `corbits-tools` package-registry asset exists
 * and carries every package in `CORBITS_TOOL_PACKAGE_DIRS`, packing
 * and pushing whatever is missing. Called ahead of deploying any
 * workflow that pins a `@corbits/*` tool package, so the closure
 * resolver finds a tarball instead of failing the launch with
 * "unknown registry".
 */
export async function publishCorbitsToolsRegistry(
  args: PublishCorbitsToolsRegistryArgs,
): Promise<PublishSummary[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const log = args.log ?? ((): void => undefined);

  const assetId = await ensureRegistryAsset(
    args.api,
    args.cookies,
    args.tenantId,
  );

  const summaries: PublishSummary[] = [];
  for (const packageDir of CORBITS_TOOL_PACKAGE_DIRS) {
    const tarball = await packToolPackageTarball(packageDir);
    const summary = await putTarball(
      args.hubUrl,
      args.cookies,
      args.tenantId,
      assetId,
      tarball,
      fetchImpl,
    );
    log(
      `published ${tarball.name}@${tarball.version} to ${CORBITS_TOOLS_REGISTRY} (commit=${summary.commit})`,
    );
    summaries.push(summary);
  }
  return summaries;
}
