// Provision a client deployment's environment variables from its manifest.
//
//   bun run scripts/provision-client.ts <client-slug> <environment> [--apply]
//
// Reads clients/<client-slug>.toml, resolves the full env-var wiring for the
// named environment, and either prints the plan (default) or applies it to
// Railway (--apply). Build/deploy config comes from the committed
// apps/*/railway.toml (Railway Config-as-Code); this script only owns per-client,
// per-environment variables and the environment itself.
//
// Prerequisite for --apply: the Railway project, its three services (hub,
// sidecar, web), Postgres plugin, and volumes already exist, their public
// domains are filled into the manifest, and `railway link` points at the
// project. See docs/CLIENT_STANDUP.md.

import {
  assertResolvedUrls,
  buildEnvPlan,
  buildRailwayVariableCommands,
  generateSecrets,
  parseManifest,
  selectEnvironment,
  SECRET_KEYS,
  type ServiceEnvPlan,
  type ServiceName,
} from "./provision-client/plan";

interface CliArgs {
  clientSlug: string;
  environment: string;
  apply: boolean;
  project?: string;
  services: Record<ServiceName, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const services: Record<ServiceName, string> = {
    hub: "hub",
    sidecar: "sidecar",
    web: "web",
  };
  let apply = false;
  let project: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--project") {
      project = argv[++i];
    } else if (arg === "--hub-service") {
      services.hub = argv[++i];
    } else if (arg === "--sidecar-service") {
      services.sidecar = argv[++i];
    } else if (arg === "--web-service") {
      services.web = argv[++i];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [clientSlug, environment] = positional;
  if (!clientSlug || !environment) {
    throw new Error(
      "Usage: bun run scripts/provision-client.ts <client-slug> <environment> [--apply] [--project ID]",
    );
  }
  return { clientSlug, environment, apply, project, services };
}

function railway(args: string[]): { stdout: string; ok: boolean } {
  const proc = Bun.spawnSync(["railway", ...args], { stderr: "pipe" });
  return {
    stdout: proc.stdout.toString(),
    ok: proc.exitCode === 0,
  };
}

function requireRailwayCli(): void {
  const probe = Bun.spawnSync(["railway", "--version"], { stderr: "pipe" });
  if (probe.exitCode !== 0) {
    throw new Error(
      "railway CLI not found. Install it and run `railway link` against the client's project first.",
    );
  }
}

function ensureEnvironment(environment: string, project?: string): void {
  const listArgs = ["environment", "list", "--json"];
  if (project) listArgs.push("--project", project);
  const listed = railway(listArgs);
  if (listed.ok && listed.stdout.includes(`"${environment}"`)) {
    return;
  }
  console.log(`Creating Railway environment "${environment}"…`);
  const newArgs = ["environment", "new", environment];
  if (project) newArgs.push("--project", project);
  const created = railway(newArgs);
  if (!created.ok) {
    throw new Error(`Failed to create environment "${environment}".`);
  }
}

function existingKeysFor(
  services: Record<ServiceName, string>,
  environment: string,
  project?: string,
): Set<string> {
  const existing = new Set<string>();
  for (const service of ["hub", "sidecar", "web"] as const) {
    const serviceName = services[service];
    const args = [
      "variables",
      "list",
      "--service",
      serviceName,
      "--environment",
      environment,
      "--json",
    ];
    if (project) args.push("--project", project);
    const res = railway(args);
    if (!res.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") {
      for (const key of Object.keys(parsed as Record<string, unknown>)) {
        existing.add(`${serviceName}:${key}`);
      }
    }
  }
  return existing;
}

function printPlan(
  plan: ServiceEnvPlan,
  clientSlug: string,
  environment: string,
): void {
  console.log(`\nEnvironment-variable plan — ${clientSlug} / ${environment}\n`);
  for (const service of ["hub", "sidecar", "web"] as const) {
    console.log(`[${service}]`);
    for (const [key, value] of Object.entries(plan[service])) {
      const marker = SECRET_KEYS.has(key)
        ? "  (secret — store in Railway only)"
        : "";
      console.log(`  ${key}=${value}${marker}`);
    }
    console.log("");
  }
  console.log(
    "DATABASE_URL is injected by the Railway Postgres plugin — do not set it.\n" +
      "Build/deploy config comes from apps/*/railway.toml (Config-as-Code).\n" +
      "Re-run with --apply to write these to Railway (needs `railway link`).",
  );
}

function apply(plan: ServiceEnvPlan, args: CliArgs): void {
  requireRailwayCli();
  ensureEnvironment(args.environment, args.project);
  const existing = existingKeysFor(
    args.services,
    args.environment,
    args.project,
  );
  const commands = buildRailwayVariableCommands(plan, {
    services: args.services,
    environment: args.environment,
    project: args.project,
    existing,
  });
  console.log(`Applying ${commands.length} variable(s) to Railway…`);
  for (const argv of commands) {
    const res = railway(argv);
    if (!res.ok) {
      throw new Error(`railway ${argv.join(" ")} failed.`);
    }
  }
  console.log(
    `Done. ${commands.length} variable(s) set on ${args.environment}. ` +
      "Secrets already present were preserved (not rotated). Trigger a deploy to pick them up.",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const manifestPath = `clients/${args.clientSlug}.toml`;
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = parseManifest(await file.text());
  const env = selectEnvironment(manifest, args.environment);
  assertResolvedUrls(env);
  const plan = buildEnvPlan(env, generateSecrets());

  if (args.apply) {
    apply(plan, args);
  } else {
    printPlan(plan, args.clientSlug, args.environment);
  }
}

await main();
