// Find-or-create a bench's 1:1 with a given deployed agent, generalizing
// `apps/web/src/myra-workbench.ts`'s original Myra-specific resolution: list
// workbench + chat kinds, reuse a chat-kind title match if one exists,
// otherwise create a chat against the agent's deployed definition. The
// agent's title and deployed asset name are config an app supplies — this
// module carries no product literal of its own.
//
// A legacy workbench-kind title match still carrying the agent is converted
// to a chat in place (one `chat/kind` settings patch): an agent chat must
// always auto-respond, and only `kind === "chat"` gets the unconditional
// fan-out in `sendWorkbenchMessage` — reusing the row as a workbench left the
// agent mention-gated and silent. A workbench-kind match with no agent
// participant is a husk that can't answer under either kind, so it is
// left alone and the real chat is created.
//
// The account's home-workbench land-hop (Myra) still uses this module's
// title match for a fast local reopen. The create at the end does not
// pass a reuse flag: `POST /workbenches` with kind=chat + definitionId
// always find-or-reopens by the definition's asset (CL-6981), so a chat
// renamed away from the agent's title is still the same conversation.

import { isAgentAddress } from "@corbits/chat/mentions";

import {
  createWorkbench,
  describeChatError,
  listWorkbenches,
  patchWorkbenchSettings,
  type Workbench,
} from "./api";

export type DefaultAgentWorkbenchConfig = {
  readonly title: string;
  readonly assetName: string | undefined;
};

export type EnsureDefaultAgentWorkbenchResult =
  | { readonly kind: "ready"; readonly workbenchId: string }
  | { readonly kind: "error"; readonly message: string };

export function isWorkbenchTitleMatch(title: string, target: string): boolean {
  return title.trim().toLowerCase() === target.trim().toLowerCase();
}

export function findWorkbenchByTitle(
  workbenches: readonly Workbench[],
  title: string,
): Workbench | undefined {
  return workbenches.find((workbench) =>
    isWorkbenchTitleMatch(workbench.title, title),
  );
}

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

  function findByTitle(
    workbenches: readonly Workbench[],
  ): Workbench | undefined {
    return findWorkbenchByTitle(workbenches, config.title);
  }

  async function ensure<
    D extends { readonly id: string; readonly name: string },
  >(
    tenantId: string,
    listDefinitions: (tenantId: string) => Promise<readonly D[]>,
  ): Promise<EnsureDefaultAgentWorkbenchResult> {
    try {
      const [workbenches, chats] = await Promise.all([
        listWorkbenches(tenantId, "workbench"),
        listWorkbenches(tenantId, "chat"),
      ]);
      const existingChat = findByTitle(chats);
      if (existingChat !== undefined) {
        cachedWorkbenchId = existingChat.id;
        return { kind: "ready", workbenchId: existingChat.id };
      }
      const legacy = findByTitle(workbenches);
      if (
        legacy !== undefined &&
        legacy.participants.some((participant) =>
          isAgentAddress(participant.address),
        )
      ) {
        await patchWorkbenchSettings(tenantId, legacy.id, {
          "chat/kind": "chat",
        });
        cachedWorkbenchId = legacy.id;
        return { kind: "ready", workbenchId: legacy.id };
      }
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
      // The home workbench still titles the mint; the server's
      // definitionId/asset dedup catches a rename, where this module's
      // own title lookup above would miss.
      const created = await createWorkbench(tenantId, {
        kind: "chat",
        definitionId: definition.id,
        name: config.title,
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
    findWorkbenchByTitle: findByTitle,
  };
}

export type DefaultAgentWorkbench = ReturnType<
  typeof createDefaultAgentWorkbench
>;
