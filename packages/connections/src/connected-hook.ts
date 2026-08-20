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
