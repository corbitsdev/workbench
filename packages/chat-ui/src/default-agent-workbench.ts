// Find-or-create a bench's 1:1 with a given deployed agent, generalizing
// `apps/web/src/myra-workbench.ts`'s original Myra-specific resolution: this
// is the one deliberate find-or-create path in the product (CL-6089), the
// account's home-workbench land-hop (Myra), where landing twice must mean
// the same conversation, never two. Every other agent-chat creation — "+ New
// Workbench" picking an agent as a template, a freshly drafted agent's own
// launch — always mints a new workbench instead.
//
// The dedup is entirely the server's: `POST /workbenches` with `kind: "chat"`
// + `definitionId` find-or-reopens by definition (see
// `packages/chat/src/routes.ts` `findExistingAgentChat`), so this module
// issues that create unconditionally and trusts the response rather than
// pre-checking anything client-side. The agent's title and deployed asset
// name are config an app supplies — this module carries no product literal
// of its own.

import { createWorkbench, describeChatError } from "./api";

export type DefaultAgentWorkbenchConfig = {
  readonly title: string;
  readonly assetName: string | undefined;
};

export type EnsureDefaultAgentWorkbenchResult =
  | { readonly kind: "ready"; readonly workbenchId: string }
  | { readonly kind: "error"; readonly message: string };

/** An agent definition matched by its deployed asset name — never by
 * display name, which is a UI label, not a wire identifier. */
export function findDefinitionByAssetName<D extends { readonly name: string }>(
  definitions: readonly D[],
  assetName: string | undefined,
): D | undefined {
  if (assetName === undefined) return undefined;
  return definitions.find((definition) => definition.name === assetName);
}

/**
 * A bound handle over one configured agent: `ensure` resolves or creates
 * its workbench, and the cached id lets a caller answer "is this the
 * default agent's workbench?" synchronously from an id alone, with no
 * workbench-title fetch of its own.
 */
export function createDefaultAgentWorkbench(
  config: DefaultAgentWorkbenchConfig,
) {
  let cachedWorkbenchId: string | null = null;

  function isCachedWorkbenchId(workbenchId: string | null): boolean {
    return workbenchId !== null && workbenchId === cachedWorkbenchId;
  }

  function resetCache(): void {
    cachedWorkbenchId = null;
  }

  async function ensure<
    D extends { readonly id: string; readonly name: string },
  >(
    tenantId: string,
    listDefinitions: (tenantId: string) => Promise<readonly D[]>,
  ): Promise<EnsureDefaultAgentWorkbenchResult> {
    try {
      const definitions = await listDefinitions(tenantId);
      const definition = findDefinitionByAssetName(
        definitions,
        config.assetName,
      );
      if (definition === undefined) {
        return {
          kind: "error",
          message: `No "${config.title}" agent found for this workbench.`,
        };
      }
      const created = await createWorkbench(tenantId, {
        kind: "chat",
        definitionId: definition.id,
        name: config.title,
        reuseExisting: true,
      });
      cachedWorkbenchId = created.id;
      return { kind: "ready", workbenchId: created.id };
    } catch (cause) {
      return {
        kind: "error",
        message: describeChatError(cause, "Couldn't open this workbench."),
      };
    }
  }

  return {
    ensure,
    isCachedWorkbenchId,
    resetCache,
  };
}

export type DefaultAgentWorkbench = ReturnType<
  typeof createDefaultAgentWorkbench
>;
