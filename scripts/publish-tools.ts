// `bun run publish-tools` — packs every `@corbits/*-tools` package and
// publishes it into an existing tenant's `corbits-tools` package-registry
// asset over the hub's native REST routes. Sign-in only, never sign-up:
// the tenant must already exist (the genesis signup or `bun run dev`'s
// seeded admin created it); this command only installs the registry
// onto it. No daemon, no new route, no new table.
//
// Environment: HUB_ADMIN_EMAIL and HUB_ADMIN_PASSWORD name the
// signing-in admin; `--tenant <id-or-slug>` picks the target tenant
// (defaults to the admin's only membership when exactly one).
import { type } from "arktype";
import { PrincipalSummary, paginatedSchema } from "@intx/types";
// Relative imports, the same convention scripts/e2e uses: the root
// package.json does not depend on these workspace packages, only the
// hub-facing products do.
import {
  createHubAPI,
  parseAs,
  signIn,
  type ApiCall,
} from "../packages/hub-api-client/src/index.ts";
import {
  publishCorbitsToolsRegistry,
  type PackedTarball,
  type PublishCorbitsToolsRegistryResult,
} from "../packages/tool-registry-publish/src/index.ts";

export type PublishToolsArgs = {
  hubUrl: string;
  email: string;
  password: string;
  /** Target tenant id or slug; required when the admin belongs to more than one tenant. */
  tenant?: string;
  log?: (line: string) => void;
  /** Test seams, mirroring `publishCorbitsToolsRegistry`'s. */
  api?: ApiCall;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  checkFreshness?: () => Promise<void>;
  packageDirs?: readonly string[];
  pack?: (packageDir: string) => Promise<PackedTarball>;
};

async function resolveTenantId(
  api: ApiCall,
  cookies: string[],
  tenant: string | undefined,
): Promise<string> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  if (tenant !== undefined) {
    const named = summary.data.find(
      (principal) =>
        principal.tenantId === tenant ||
        principal.tenantSlug === tenant ||
        principal.tenantName === tenant,
    );
    if (named === undefined) {
      throw new Error(
        `publish-tools: no tenant matching "${tenant}" in the signed-in admin's memberships (${summary.data.map((principal) => principal.tenantSlug).join(", ")})`,
      );
    }
    return named.tenantId;
  }
  if (summary.data.length !== 1) {
    throw new Error(
      `publish-tools: --tenant is required when the admin belongs to ${summary.data.length} tenants (${summary.data.map((principal) => principal.tenantSlug).join(", ")})`,
    );
  }
  const only = summary.data[0];
  if (only === undefined) {
    throw new Error(
      "publish-tools: the signed-in admin belongs to no tenant; sign up or seed an account first",
    );
  }
  return only.tenantId;
}

export async function runPublishTools(
  args: PublishToolsArgs,
): Promise<PublishCorbitsToolsRegistryResult> {
  const log = args.log ?? ((): void => undefined);
  const api = args.api ?? createHubAPI(args.hubUrl);
  const session = await signIn(api, {
    email: args.email,
    password: args.password,
  });
  log(`signed in as ${args.email}`);
  const tenantId = await resolveTenantId(api, session.cookies, args.tenant);
  log(`publishing the corbits-tools registry onto tenant ${tenantId}`);
  return publishCorbitsToolsRegistry({
    api,
    cookies: session.cookies,
    hubUrl: args.hubUrl,
    tenantId,
    log,
    ...(args.checkFreshness !== undefined
      ? { checkFreshness: args.checkFreshness }
      : {}),
    ...(args.fetchImpl !== undefined ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.packageDirs !== undefined
      ? { packageDirs: args.packageDirs }
      : {}),
    ...(args.pack !== undefined ? { pack: args.pack } : {}),
  });
}

const Args = type({
  "tenant?": "string",
});

async function main(): Promise<void> {
  const email = process.env["HUB_ADMIN_EMAIL"];
  const password = process.env["HUB_ADMIN_PASSWORD"];
  if (
    email === undefined ||
    email === "" ||
    password === undefined ||
    password === ""
  ) {
    console.error(
      "publish-tools: set HUB_ADMIN_EMAIL and HUB_ADMIN_PASSWORD to an existing admin account, and start the stack with `bun run dev` first.",
    );
    process.exit(1);
  }
  const raw = process.argv.slice(2);
  const tenantIndex = raw.indexOf("--tenant");
  const tenant =
    tenantIndex >= 0 ? (raw[tenantIndex + 1] ?? undefined) : undefined;
  const parsed = Args({ tenant });
  if (parsed instanceof type.errors) {
    console.error(`publish-tools: ${parsed.summary}`);
    process.exit(1);
  }
  const hubUrl = process.env["BASE_URL"] ?? "http://localhost:3000";
  const result = await runPublishTools({
    hubUrl,
    email,
    password,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}),
    log: (line) => console.log(`[publish-tools] ${line}`),
  });
  console.log(
    `[publish-tools] done: ${result.summaries.length} tarball(s) uploaded`,
  );
}

if (import.meta.main) {
  main();
}
