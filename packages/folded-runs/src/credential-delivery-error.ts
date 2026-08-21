// Classifies a failed `buildCredentialDelivery` call into the error a
// launch should throw. `code: "unresolved"` is the one case a person can
// actually act on — the credential simply isn't connected yet — so it
// becomes a `MissingCredentialError` naming the connector, instead of the
// generic `Error` every failure used to collapse into (CL-6495: a launch
// that halts on a missing credential is only useful if something upstream
// can tell that apart from every other launch failure). `"no_origin"` and
// `"ambiguous"` are configuration faults, not a missing connection, so
// they stay generic.
import type { CredentialDeliveryFailure } from "@intx/db";
import { MissingCredentialError } from "@workbench/connections";

export function credentialDeliveryError(
  launchLabel: string,
  reason: CredentialDeliveryFailure,
): Error {
  if (reason.code === "unresolved") {
    return new MissingCredentialError(reason.binding.provider);
  }
  return new Error(
    `${launchLabel}: credential binding resolution failed: ${reason.message}`,
  );
}
