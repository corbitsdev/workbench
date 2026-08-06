// `workbench setup`: initialize the database, provision the
// bench through the hub's native tenant-creation route, report
// the role defaults the platform created, and state exactly what the
// operator must still supply. Safe to re-run; every skipped step says
// so.

import {
  paginatedSchema,
  PrincipalSummary,
  RoleResponse,
  TenantResponse,
} from "@intx/types";
import {
  authenticate,
  parseAs,
  CliError,
  type ApiCall,
} from "@workbench/hub-client";
import { MODEL_CREDENTIAL_VARIABLES, type SetupConfig } from "./config";

export type SetupDeps = {
  config: SetupConfig;
  api: ApiCall;
  /** Runs the shared database-initialization script; throws CliError. */
  runDbSetup: () => Promise<void>;
  log: (line: string) => void;
};

async function ensureTenant(
  api: ApiCall,
  cookies: string[],
  args: { name: string; slug: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    "/api/tenants",
    { name: args.name, slug: args.slug },
    cookies,
  );
  if (created.status === 201) {
    const tenant = parseAs(TenantResponse, created.data, "tenant response");
    log(`created bench ${args.slug} (${tenant.id})`);
    return tenant.id;
  }

  const principals = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    principals.data,
    "principals response",
  );
  const existing = summary.data.find((p) => p.tenantSlug === args.slug);
  if (existing) {
    log(`bench ${args.slug} already exists (skipped)`);
    return existing.tenantId;
  }

  throw new CliError(
    `the hub rejected creation of bench ${args.slug} with status ${created.status}: ${JSON.stringify(created.data)}`,
    "pick a different WORKBENCH_ORG_SLUG, or check the hub logs for the underlying failure, then re-run: workbench setup",
  );
}

export async function runSetup(deps: SetupDeps): Promise<void> {
  const { config, api, log } = deps;

  log("initializing database...");
  await deps.runDbSetup();

  const session = await authenticate(api, {
    email: config.adminEmail,
    password: config.adminPassword,
  });
  log(
    session.signedUp
      ? `created administrator ${config.adminEmail}`
      : `administrator ${config.adminEmail} already exists (skipped)`,
  );

  const tenantId = await ensureTenant(
    api,
    session.cookies,
    { name: config.orgName, slug: config.orgSlug },
    log,
  );

  const roles = await api(
    "GET",
    `/api/tenants/${tenantId}/roles?limit=100`,
    undefined,
    session.cookies,
  );
  const roleList = parseAs(
    paginatedSchema(RoleResponse),
    roles.data,
    "roles response",
  ).data;
  if (roleList.length === 0) {
    throw new CliError(
      `bench ${config.orgSlug} has zero roles; the platform should have created its role defaults (owner, admin, member) at tenant creation`,
      "check the hub logs for the tenant-creation failure, then re-run: workbench setup",
    );
  }
  log(
    `role defaults in place: ${roleList
      .map((r) => r.name)
      .sort()
      .join(", ")}`,
  );

  log("");
  log("setup complete. still required from you:");
  log("  your model credential, as environment variables:");
  for (const variable of MODEL_CREDENTIAL_VARIABLES) {
    log(`    ${variable}`);
  }
  log("then deploy the default workflows: workbench seed");
}
