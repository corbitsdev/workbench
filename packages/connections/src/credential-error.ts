// The one typed signal for "this connector's credential is missing" —
// the pop-up that lets someone connect it can't target the right
// connector unless that identity survives past the failure. Today it
// doesn't: `packages/folded-runs/src/launch.ts` discards
// `buildCredentialDelivery`'s own `reason.binding.provider` into a
// generic `Error` string, and every tool package bakes its own
// hardcoded "not connected" prose instead of naming the connector
// structurally. This class is the shared, identifiable shape a thrower
// and a catcher can agree on. `displayName` comes straight from
// `CONNECTOR_REGISTRY` — the one place a connector's consumer-facing
// name lives — so nothing downstream re-derives or hand-writes it, and
// a caller never has to fall back to showing the raw connector id.
import { CONNECTOR_REGISTRY } from "./registry";

export class MissingCredentialError extends Error {
  readonly connectorId: string;
  readonly displayName: string;

  constructor(connectorId: string) {
    const displayName =
      CONNECTOR_REGISTRY[connectorId]?.displayName ?? connectorId;
    super(`${displayName} is not connected.`);
    this.name = "MissingCredentialError";
    this.connectorId = connectorId;
    this.displayName = displayName;
  }
}
