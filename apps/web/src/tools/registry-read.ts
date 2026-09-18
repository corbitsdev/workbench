// Reads the tenant's published tool packages off its `corbits-tools`
// package-registry asset's tarball listing. There is no packument route —
// a tarball entry is only ever `<name>-<version>.tgz` — so name/version are
// recovered from the filename and nothing further (description, declared
// tools) is available without unpacking the tarball itself.

import { type } from "arktype";
import { useQuery } from "@tanstack/react-query";

import { ApiQueryError, UnauthenticatedError, toAPIQuery, type APIQuery } from "@/lib/api-query";

const AssetListShape = type({ id: "string", name: "string" }).array();
const TarballListShape = type({ filename: "string", size: "number", integrity: "string" }).array();

export type ToolPackage = {
  readonly filename: string;
  readonly name: string;
  readonly version: string;
};

// Mirrors `tarballFilenameFor`: `<name-without-@-scope-slash>-<semver>.tgz`.
const TARBALL_NAME_PATTERN = /^(.+)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.tgz$/;

function parseTarballFilename(filename: string): ToolPackage | null {
  const match = TARBALL_NAME_PATTERN.exec(filename);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { filename, name: match[1], version: match[2] };
}

async function getJSON<T>(path: string, schema: (data: unknown) => T | type.errors): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) throw new UnauthenticatedError();
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

/** Every tarball published across the tenant's own package-registry assets
 * (`inherited=false`: a tool package published to an ancestor tenant is
 * that ancestor's own concern, not this bench's roster). */
async function listToolPackages(tenantId: string): Promise<readonly ToolPackage[]> {
  const registries = await getJSON(
    `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`,
    AssetListShape,
  );
  const perRegistry = await Promise.all(
    registries.map((registry) =>
      getJSON(
        `/api/tenants/${tenantId}/assets/${encodeURIComponent(registry.id)}/tarballs`,
        TarballListShape,
      ),
    ),
  );
  return perRegistry
    .flat()
    .map((tarball) => parseTarballFilename(tarball.filename))
    .filter((pkg): pkg is ToolPackage => pkg !== null);
}

/** The tenant's published tool packages, for the Tools page. */
export function useToolPackages(tenantId: string | null): APIQuery<readonly ToolPackage[]> {
  const result = useQuery({
    queryKey: ["tenant", tenantId ?? "none", "tools", "packages"] as const,
    enabled: tenantId !== null,
    queryFn: () => listToolPackages(tenantId as string),
  });
  return toAPIQuery(result);
}
