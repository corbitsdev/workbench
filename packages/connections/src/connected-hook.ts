// The one seam every connect surface fires once a credential is
// durably stored (CL-6393): OAuth callback, pasted API key, MCP OAuth,
// and keyless MCP preset all report the same shape, so a composition
// (the hub) can settle in-room connect cards and resume waiting agents
// without knowing which door the connection came through. Best-effort
// by contract: a hook failure is logged and never breaks the connect
// itself — the credential is already stored when this fires.

export type ServiceConnectedInfo = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly connectorId: string;
  readonly displayName: string;
};

export type ServiceConnectedHook = (
  info: ServiceConnectedInfo,
) => Promise<void>;

export async function fireConnectedHook(
  hook: ServiceConnectedHook | undefined,
  log: (line: string) => void,
  info: ServiceConnectedInfo,
): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(info);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(
      `onConnected hook failed for ${info.connectorId} on tenant ${info.tenantId}: ${message}`,
    );
  }
}

// A second, narrower seam: fires only when an inference connector's
// `/complete` just left the tenant with `hasUsableModel` true — a model
// with a resolvable offering, whether or not this tenant's bench has
// ever deployed its default workflows. A composition wires this to the
// same durable pending-seed drain the onboarding credential step already
// feeds (`@workbench/onboarding`'s `pendingSeedStore` + `benchProvisioner`),
// so a tenant that connects its own provider through Settings converges
// on Myra and the default workflow set exactly like one that connects
// through onboarding — never stuck waiting on an operator-configured
// hub key. `apiKey` here is the same secret `/complete` just stored
// (the URL placeholder for a `credentialInputKind: "url"` connector like
// Ollama, a real key otherwise); never logged, never returned to the
// caller.
export type InferenceCredentialSeedableInfo = {
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantDomain: string;
  readonly principalId: string;
  readonly provider: string;
  readonly apiKey: string;
  /** The real instance origin a `credentialInputKind: "url"` connector
   * (Ollama) was just pointed at — absent for every other provider.
   * Carried through to the drain so its deploy targets this tenant's
   * actual endpoint rather than a curated default. */
  readonly baseURLOverride?: string;
};

export type InferenceCredentialSeedableHook = (
  info: InferenceCredentialSeedableInfo,
) => Promise<void> | void;

export async function fireInferenceCredentialSeedableHook(
  hook: InferenceCredentialSeedableHook | undefined,
  log: (line: string) => void,
  info: InferenceCredentialSeedableInfo,
): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(info);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(
      `onInferenceCredentialUsable hook failed for ${info.provider} on tenant ${info.tenantId}: ${message}`,
    );
  }
}
