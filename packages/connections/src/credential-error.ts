// The one typed signal for "this connector's credential is missing" —
// the pop-up that lets someone connect it can't target the right
// connector unless that identity survives past the failure. Today it
// doesn't: `packages/folded-runs/src/launch.ts` discards
// `buildCredentialDelivery`'s own `reason.binding.provider` into a
// generic `Error` string, and every tool package bakes its own
// hardcoded "not connected" prose instead of naming the connector
// structurally. This class is the shared, identifiable shape a thrower
// and a catcher can agree on. `displayName` is an optional caller-supplied
// override (this package carries no connector set of its own to look one
// up in, CL-7384) — a caller with a registry handy passes the connector's
// `displayName`; one without falls back to the raw connector id.
export class MissingCredentialError extends Error {
  readonly connectorId: string;
  readonly displayName: string;

  constructor(connectorId: string, displayName?: string) {
    const resolvedDisplayName = displayName ?? connectorId;
    super(`${resolvedDisplayName} is not connected.`);
    this.name = "MissingCredentialError";
    this.connectorId = connectorId;
    this.displayName = resolvedDisplayName;
  }
}
