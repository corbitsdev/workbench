// The room-side ledger behind the in-room connect flow (CL-6393). A
// `connect-service` card posted into a room registers the connector on
// the room's own settings under `connections/pending`; when the
// connection completes in the browser, `settleConnectedService` finds
// every room in the tenant still waiting on that connector, clears the
// entry (publishing `chat.settings` so the open card flips), and posts
// a message under the connecting person's own address — which routes to
// the room's host agent through the ordinary message path, so the agent
// resumes the task it parked without any new trigger machinery.
import { type } from "arktype";

import {
  sendWorkbenchMessage,
  type SendWorkbenchMessageDeps,
} from "./workbench-service";
import type { ChatStore } from "./store";
import type { Part as PartType } from "./parts";
import { ConnectServiceBlockData } from "./blocks";

export const CONNECTIONS_PENDING_KEY = "connections/pending";

const PendingConnections = type("string[]");

export function pendingConnectionsOf(
  settings: Record<string, unknown>,
): readonly string[] {
  const parsed = PendingConnections(settings[CONNECTIONS_PENDING_KEY]);
  if (parsed instanceof type.errors) return [];
  return parsed;
}

/** Connector ids named by `connect-service` block parts in a message —
 * parsed through the block's own schema so a malformed block registers
 * nothing. */
export function connectServiceConnectorIds(
  parts: readonly PartType[],
): readonly string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (part.kind !== "block" || part.block.type !== "connect-service") {
      continue;
    }
    const data = ConnectServiceBlockData(part.block.data);
    if (data instanceof type.errors) continue;
    if (!ids.includes(data.connectorId)) ids.push(data.connectorId);
  }
  return ids;
}

/** A curated MCP preset is pending as either its bare slug or the
 * `mcp:`-prefixed connector id its connection is minted under —
 * matching strips the prefix from both sides so the card settles
 * whichever spelling registered it. */
function bareConnectorId(connectorId: string): string {
  return connectorId.startsWith("mcp:")
    ? connectorId.slice("mcp:".length)
    : connectorId;
}

export type SettleConnectedServiceDeps = SendWorkbenchMessageDeps & {
  readonly store: Pick<
    ChatStore,
    "listWorkbenchSettings" | "updateWorkbenchSettings"
  > &
    SendWorkbenchMessageDeps["store"];
  readonly senderAddressFor: (
    tenantId: string,
    principalId: string,
  ) => string | Promise<string>;
};

export type SettleConnectedServiceInput = {
  readonly tenantId: string;
  /** The person whose browser completed the connection — the settle
   * message posts under their own address, and the message's ordinary
   * routing is what wakes the room's host agent. */
  readonly principalId: string;
  readonly connectorId: string;
  readonly displayName: string;
};

export async function settleConnectedService(
  deps: SettleConnectedServiceDeps,
  input: SettleConnectedServiceInput,
): Promise<void> {
  const rows = await deps.store.listWorkbenchSettings(input.tenantId);
  const connected = bareConnectorId(input.connectorId);
  for (const row of rows) {
    const pending = pendingConnectionsOf(row.settings);
    if (!pending.some((entry) => bareConnectorId(entry) === connected)) {
      continue;
    }
    const remaining = pending.filter(
      (entry) => bareConnectorId(entry) !== connected,
    );
    const updated = await deps.store.updateWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId: row.workbenchId,
      settings: { ...row.settings, [CONNECTIONS_PENDING_KEY]: remaining },
      updatedBy: input.principalId,
    });
    deps.publish(row.workbenchId, {
      type: "chat.settings",
      data: { updatedBy: input.principalId, settings: updated.settings },
    });
    await sendWorkbenchMessage(deps, {
      tenantId: input.tenantId,
      principalId: input.principalId,
      senderAddress: await deps.senderAddressFor(
        input.tenantId,
        input.principalId,
      ),
      workbenchId: row.workbenchId,
      messageParts: [
        {
          kind: "text",
          text: `${input.displayName} is connected now — go ahead.`,
        },
      ],
    });
  }
}
