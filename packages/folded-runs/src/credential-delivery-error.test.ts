import { describe, expect, test } from "bun:test";
import { MissingCredentialError } from "@corbits/connections";
import type { CredentialDeliveryFailure } from "@intx/db";

import { credentialDeliveryError } from "./credential-delivery-error";

describe("credentialDeliveryError", () => {
  test("names the missing connector instead of a generic failure", () => {
    const reason: CredentialDeliveryFailure = {
      code: "unresolved",
      binding: {
        provider: "github",
        package: "@corbits/github-tools",
        handle: "github",
      },
      message: "no credential resolves this binding",
    };

    const error = credentialDeliveryError("the agent", reason);

    expect(error).toBeInstanceOf(MissingCredentialError);
    expect((error as MissingCredentialError).connectorId).toBe("github");
    expect((error as MissingCredentialError).displayName).toBe("GitHub");
  });

  test("keeps a generic error for a non-missing-credential failure", () => {
    const reason: CredentialDeliveryFailure = {
      code: "ambiguous",
      binding: {
        provider: "github",
        package: "@corbits/github-tools",
        handle: "github",
      },
      message: "more than one candidate credential resolves this binding",
    };

    const error = credentialDeliveryError("the agent", reason);

    expect(error).not.toBeInstanceOf(MissingCredentialError);
    expect(error.message).toContain(
      "more than one candidate credential resolves this binding",
    );
  });
});
