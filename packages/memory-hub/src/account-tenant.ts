// Memory scopes to the bench/account tenant, never a workbench tenant and
// never the operator tenant — the tenant hierarchy is three levels deep
// (`AGENTS.md`'s CL-6289 decision): operator tenant (deployment, optional) >
// personal bench tenant (the account, minted on first login by
// `packages/onboarding/src/provision.ts` as the operator's direct child) >
// workbench tenants (children of the bench, minted by
// `packages/chat/src/workbench-tenancy.ts`). So the same human reaches the
// SAME memory whether they're acting in a workbench or in the bench itself,
// and two different accounts NEVER collide, however deep either caller's
// own tenant sits.
//
// Walks the ancestor chain the same way `packages/agent-directory/src/
// visible-definitions.ts` and `workbench-tenancy.ts` (~line 471) do —
// `@intx/db`'s own `getAncestorChain`, never a hand-rolled query — and
// reuses its cycle guard rather than imposing a second depth cap.
import { getAncestorChain, type DB } from "@intx/db";

export class OperatorTenantHasNoAccountScopeError extends Error {
  constructor(operatorTenantId: string) {
    super(
      `tenant "${operatorTenantId}" is the operator tenant itself — there ` +
        "is no bench/account tenant beneath it to scope memory to. This " +
        "caller has no memory scope.",
    );
    this.name = "OperatorTenantHasNoAccountScopeError";
  }
}

export type ResolveAccountTenantIdArgs = {
  readonly db: DB["db"];
  /** The tenant the request actually arrived on — a workbench tenant, the
   * bench tenant itself, or (the one rejected case) the operator tenant. */
  readonly tenantId: string;
  /** `OPERATOR_TENANT_ID`, when this deploy has one. Absent means every
   * bench is already a root tenant (`parentId === null`), so the walk's
   * root rule below applies directly. */
  readonly operatorTenantId?: string;
};

/**
 * Resolves the bench/account tenant memory scopes to, from whatever tenant
 * the request arrived on.
 *
 * The operator tenant is NEVER a memory scope and the walk never ascends
 * into it: doing so would merge every account on this deploy into one
 * shared memory store, a serious privacy failure, not a convenience. So
 * when `operatorTenantId` is configured and appears in this tenant's own
 * ancestor chain, the account tenant is the entry immediately BELOW it —
 * one hop short of the root, not the root itself. A caller whose own
 * tenant IS the operator tenant has no account beneath it and gets no
 * scope: `OperatorTenantHasNoAccountScopeError`, never a silent fallback to
 * the operator tenant's own "scope".
 *
 * Two topologies both terminate correctly, and a bench must resolve to
 * itself under either:
 *   - No operator tenant configured (or this particular bench predates one
 *     being set, so the operator tenant never appears in its chain): the
 *     bench is already the chain's root (`parentId === null`) — the
 *     account tenant IS the root. This also means configuring
 *     `OPERATOR_TENANT_ID` later never repoints an existing, already-root
 *     bench at a different memory store.
 *   - Operator tenant configured and present in the chain: the account
 *     tenant is the chain entry one hop below it.
 */
export async function resolveAccountTenantId(
  args: ResolveAccountTenantIdArgs,
): Promise<string> {
  const chain = await getAncestorChain(args.db, args.tenantId);

  if (args.operatorTenantId !== undefined) {
    const operatorIndex = chain.indexOf(args.operatorTenantId);
    if (operatorIndex === 0) {
      throw new OperatorTenantHasNoAccountScopeError(args.operatorTenantId);
    }
    if (operatorIndex > 0) return chain[operatorIndex - 1] as string;
    // operatorIndex === -1: the operator tenant never appears in this
    // tenant's own ancestry (a bench minted before OPERATOR_TENANT_ID was
    // set) — fall through to the root rule below rather than erroring.
  }

  // The root rule: with no operator tenant in view, the bench is already
  // the top of its own chain.
  return chain[chain.length - 1] as string;
}
