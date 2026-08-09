// Emit-time authorization and credential resolution for one sink, in one
// place. Read-time authorization needs nothing here: a mailbox is scoped to a
// single principal by construction, so there is no cross-principal read to
// guard. What has to be checked is the other direction — whether this install
// may push a principal's notification out to an external place at all.
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";

export type NotifyCredential = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
};

export type NotifyContext = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sinkName: string;
  readonly credential: NotifyCredential;
};

export class NotifyGrantMissingError extends Error {
  constructor(sinkName: string, tenantId: string) {
    super(
      `No grant allows delivering notifications through the ${JSON.stringify(sinkName)} ` +
        `sink in this workspace. Grant "notify:${sinkName}" in ${tenantId} first.`,
    );
    this.name = "NotifyGrantMissingError";
  }
}

export class NotifySinkNotConfiguredError extends Error {
  constructor(sinkName: string) {
    super(
      `The ${JSON.stringify(sinkName)} notification sink has no credential configured ` +
        "in this workspace, so there is nothing to deliver through.",
    );
    this.name = "NotifySinkNotConfiguredError";
  }
}

export class NotifySinkCredentialInvalidError extends Error {
  constructor(sinkName: string, expectedKind: string, actualKind: string) {
    super(
      `The credential configured for the ${JSON.stringify(sinkName)} notification sink is a ` +
        `${JSON.stringify(actualKind)} credential, but the sink needs a ${JSON.stringify(expectedKind)} one.`,
    );
    this.name = "NotifySinkCredentialInvalidError";
  }
}

export const NOTIFY_DELIVER_ACTION = "deliver";

export interface ResolveNotifyContextDeps {
  readonly grantStore: GrantStore;
  readonly conditionRegistry?: ConditionRegistry;
  /** The credential an operator configured for this sink in this workspace, if any. */
  readonly findSinkCredential: (args: {
    tenantId: string;
    sinkName: string;
  }) => Promise<NotifyCredential | null>;
}

export interface ResolveNotifyContextArgs {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sinkName: string;
  readonly credentialKind: string;
}

/**
 * Resolve the grant and credential one sink delivery needs, or throw a named
 * error saying exactly which of the three is missing. Grants are the platform's
 * own — the resource string is `notify:<sinkName>`, matched by `@intx/authz`
 * the same way `approval:<deploymentId>` is.
 */
export async function resolveNotifyContext(
  deps: ResolveNotifyContextDeps,
  args: ResolveNotifyContextArgs,
): Promise<NotifyContext> {
  const result = await authorize(
    deps.grantStore,
    args.principalId,
    args.tenantId,
    `notify:${args.sinkName}`,
    NOTIFY_DELIVER_ACTION,
    deps.conditionRegistry,
  );
  if (result.effect !== "allow") {
    throw new NotifyGrantMissingError(args.sinkName, args.tenantId);
  }
  const credential = await deps.findSinkCredential({
    tenantId: args.tenantId,
    sinkName: args.sinkName,
  });
  if (credential === null) {
    throw new NotifySinkNotConfiguredError(args.sinkName);
  }
  if (credential.kind !== args.credentialKind) {
    throw new NotifySinkCredentialInvalidError(
      args.sinkName,
      args.credentialKind,
      credential.kind,
    );
  }
  return {
    tenantId: args.tenantId,
    principalId: args.principalId,
    sinkName: args.sinkName,
    credential,
  };
}
