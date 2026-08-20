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

  const hubError =
    created.status === 403 &&
    typeof created.data === "object" &&
    created.data !== null &&
    "error" in created.data &&
    typeof created.data.error === "object" &&
    created.data.error !== null &&
    "code" in created.data.error &&
    created.data.error.code === "signup_not_allowed"
      ? created.data.error
      : undefined;
  if (hubError !== undefined && "message" in hubError) {
    throw new CliError(
      String(hubError.message),
      "set ALLOW_UNVERIFIED_EMAILS=1 in .env for local development, then re-run: workbench setup",
    );
  }

  throw new CliError(
    `the hub rejected creation of bench ${args.slug} with status ${created.status}: ${JSON.stringify(created.data)}`,
    "pick a different ORG_SLUG, or check the hub logs for the underlying failure, then re-run: workbench setup",
  );
}

export async function runSetup(deps: SetupDeps): Promise<void> {
  const { config, api, log } = deps;
  if (config.adminDefaulted) {
    log(
      "using default admin alice@example.com — set HUB_ADMIN_EMAIL and HUB_ADMIN_PASSWORD for real deployments",
    );
  }

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
  log("setup complete. next: workbench seed");
  for (const variable of MODEL_CREDENTIAL_VARIABLES) {
    log(`  ${variable}`);
  }
}
