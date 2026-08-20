// CL-6345: read-only tool calls ride the grant allowance instead of
// per-call approval. An `approval: "ask"` tool call parks as a pending
// approval row the moment the sidecar registers its suspension
// (`registerSignalCorrelation`); this module is the allowance gate that
// runs right after that registration. A call whose tool carries a
// declarative allowance annotation, classifies as read-only for THESE
// arguments, and whose resolved resource (`repo:<owner/name>`,
// `room:<id>`, `mcp:<slug>`, ...) an existing `allow` grant in the
// tenant's grant store covers is auto-approved through the native
// resolve machinery — the approval row still exists and flips to
// "approved", so the decision is ledgered, but no card ever needs a
// human. Every other call — unannotated tools, write classifications,
// uncovered resources, classification failures — keeps today's parked
// behavior unchanged.
//
// Classification is registry-declarative: an annotation is keyed by the
// qualified tool name the approval row carries and supplies its own
// `classify` (which may verify a downstream claim live, e.g. an MCP
// server's `readOnlyHint`). Nothing here matches tool names ad hoc at
// the call site, and coverage is always resolved through the real grant
// rows (`@intx/authz`'s `evaluateGrants`), never a parallel store.
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";

export type AllowanceClassification =
  | { readonly readOnly: true; readonly resource: string }
  | { readonly readOnly: false };

/**
 * One tool's declarative allowance annotation. `classify` receives the
 * parked call's arguments and answers whether THIS invocation is
 * read-only and which resource it touches; `grantAction` names the
 * action the covering grant must allow on that resource (the action the
 * standing grant was minted with, e.g. `"read"`).
 */
export type ToolAllowance = {
  /** Qualified tool name exactly as the approval row records it. */
  readonly tool: string;
  readonly grantAction: string;
  readonly classify: (
    tenantId: string,
    toolArguments: Record<string, unknown>,
  ) => Promise<AllowanceClassification>;
};

export type ToolAllowanceRegistry = ReadonlyMap<string, ToolAllowance>;

export function createToolAllowanceRegistry(
  allowances: readonly ToolAllowance[],
): ToolAllowanceRegistry {
  const registry = new Map<string, ToolAllowance>();
  for (const allowance of allowances) {
    if (registry.has(allowance.tool)) {
      throw new Error(
        `createToolAllowanceRegistry: duplicate allowance for tool "${allowance.tool}"`,
      );
    }
    registry.set(allowance.tool, allowance);
  }
  return registry;
}

export type AllowanceDecision =
  | {
      readonly outcome: "ride";
      readonly resource: string;
      readonly grantId: string;
    }
  | {
      readonly outcome: "park";
      readonly reason:
        | "unclassified"
        | "not_read_only"
        | "no_resource"
        | "no_covering_grant"
        | "classification_failed";
    };

/**
 * The pure allowance decision: park unless the tool is annotated, the
 * call classifies read-only, and an `allow` grant in `grants` covers
 * the classified resource under the annotation's action. Fails closed —
 * a throwing classifier parks rather than rides.
 */
export async function evaluateToolAllowance(args: {
  registry: ToolAllowanceRegistry;
  tenantId: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  grants: GrantRule[];
}): Promise<AllowanceDecision> {
  const allowance = args.registry.get(args.toolName);
  if (allowance === undefined)
    return { outcome: "park", reason: "unclassified" };

  let classification: AllowanceClassification;
  try {
    classification = await allowance.classify(
      args.tenantId,
      args.toolArguments,
    );
  } catch {
    return { outcome: "park", reason: "classification_failed" };
  }
  if (!classification.readOnly) {
    return { outcome: "park", reason: "not_read_only" };
  }
  if (classification.resource.length === 0) {
    return { outcome: "park", reason: "no_resource" };
  }

  const decision = await evaluateGrants(
    args.grants,
    classification.resource,
    allowance.grantAction,
    { tenantId: args.tenantId },
  );
  if (decision.effect !== "allow" || decision.resolvedBy === null) {
    return { outcome: "park", reason: "no_covering_grant" };
  }
  return {
    outcome: "ride",
    resource: classification.resource,
    grantId: decision.resolvedBy.id,
  };
}

export type RegisteredApprovalRef = {
  readonly approvalId: string;
  readonly tenantId: string;
};

export type GrantAllowanceGateDeps = {
  registry: ToolAllowanceRegistry;
  /** The pending approval the registration just co-wrote, by correlation. */
  findRegisteredApproval(
    correlationId: string,
  ): Promise<RegisteredApprovalRef | null>;
  /** The tenant's live grant rows — role- and principal-scoped alike. */
  listTenantGrants(tenantId: string): Promise<GrantRule[]>;
  /**
   * Resolves the approval "approved" through the native resolve
   * machinery with allowance (null-principal) authority. Returns whether
   * the resolution actually landed — a false is logged, never thrown.
   */
  autoApprove(args: {
    approvalId: string;
    tenantId: string;
    resource: string;
    grantId: string;
  }): Promise<boolean>;
  log(line: string): void;
};

type RegisterApprovalArgs = {
  readonly correlationId: string;
  readonly approvalSnapshot: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
};

/**
 * Wraps a `registerSignalCorrelation` lookup: after the base
 * registration co-writes the pending approval, evaluates the allowance
 * and auto-approves a riding call. Never throws into the registration
 * path — an allowance failure leaves the approval parked, which is the
 * safe (status quo) outcome.
 */
export function withGrantAllowance<Args extends RegisterApprovalArgs>(
  base: (args: Args) => Promise<void>,
  deps: GrantAllowanceGateDeps,
): (args: Args) => Promise<void> {
  return async (args: Args) => {
    await base(args);
    if (!deps.registry.has(args.approvalSnapshot.name)) return;
    try {
      const registered = await deps.findRegisteredApproval(args.correlationId);
      if (registered === null) return;
      const decision = await evaluateToolAllowance({
        registry: deps.registry,
        tenantId: registered.tenantId,
        toolName: args.approvalSnapshot.name,
        toolArguments: args.approvalSnapshot.arguments,
        grants: await deps.listTenantGrants(registered.tenantId),
      });
      if (decision.outcome !== "ride") {
        deps.log(
          `grant-allowance: ${args.approvalSnapshot.name} parked (${decision.reason})`,
        );
        return;
      }
      const resolved = await deps.autoApprove({
        approvalId: registered.approvalId,
        tenantId: registered.tenantId,
        resource: decision.resource,
        grantId: decision.grantId,
      });
      deps.log(
        resolved
          ? `grant-allowance: ${args.approvalSnapshot.name} rode grant ${decision.grantId} on ${decision.resource} (approval ${registered.approvalId} auto-approved)`
          : `grant-allowance: ${args.approvalSnapshot.name} covered by ${decision.grantId} but approval ${registered.approvalId} did not resolve; left parked`,
      );
    } catch (cause) {
      deps.log(
        `grant-allowance: ${args.approvalSnapshot.name} evaluation failed, left parked: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
}
