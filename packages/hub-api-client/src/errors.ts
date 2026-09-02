/**
 * A failure the operator can act on. Every error the hub client raises
 * names the exact problem and carries the command or change that fixes
 * it, so a fresh user is never left guessing.
 */
export class HubApiError extends Error {
  readonly fix: string;

  constructor(problem: string, fix: string, options?: ErrorOptions) {
    super(problem, options);
    this.name = "HubApiError";
    this.fix = fix;
  }
}

export function isHubApiError(value: unknown): value is HubApiError {
  return value instanceof HubApiError;
}

/**
 * The specific `HubApiError` `ensureDeployment` raises when the hub answers
 * a workflow-deployment create with 502 `sidecar_unavailable`: the
 * sidecar that hosts workflow execution is down, but every durable step
 * ahead of it (tenant, grants, credential, catalog, workflow assets)
 * already succeeded. Onboarding's `ensureSeeded` (see
 * `@workbench/onboarding`'s `complete-credential.ts`) parses this exact
 * class to finish the request successfully with an honest "agents
 * pending" report, instead of failing the whole flow the way any other
 * `HubApiError` still does.
 */
export class SidecarUnavailableError extends HubApiError {
  constructor(problem: string, fix: string, options?: ErrorOptions) {
    super(problem, fix, options);
    this.name = "SidecarUnavailableError";
  }
}

export function isSidecarUnavailableError(
  value: unknown,
): value is SidecarUnavailableError {
  return value instanceof SidecarUnavailableError;
}
