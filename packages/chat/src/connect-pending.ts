// The room-side ledger behind the in-room connect flow (CL-6393). A
// `connect-service` card posted into a room registers the connector on
// the room's own settings under `connections/pending`; when the
// connection completes in the browser, `settleConnectedService` finds
// every room in the tenant still waiting on that connector, clears the
// entry (publishing `chat.settings` so the open card flips), and posts
// a message under the connecting person's own address — which routes to
// the room's host agent through the ordinary message path, so the agent
// resumes the task it parked without any new trigger machinery.
//
// CL-6463: the code-review template's own GitHub connect card registers
// under a second, template-owned key (`@corbits/workflow-catalog`'s
// `template/pendingConnections`) instead of `connections/pending` — a
// credential completed anywhere other than that card's own submit (the
// Plugins page, another tab) never reached it. Rather than stand up a
// second settle path for that one key, this module settles both: a
// connector becoming connected is one event, and every room's settling
// belongs to one mechanism, not two parallel key conventions.
import { type } from "arktype";

import {
  sendWorkbenchMessage,
  type SendWorkbenchMessageDeps,
} from "./workbench-service";
import type { ChatStore } from "./store";
import type { Part as PartType } from "./parts";
import { ConnectServiceBlockData } from "./blocks";

export const CONNECTIONS_PENDING_KEY = "connections/pending";

/** The code-review template's own pending-connections key
 * (`@corbits/workflow-catalog`'s `templateSettingsPatch`/
 * `templateReposSettingsPatch`) — a room minted from that template
 * tracks its GitHub card's pending state here instead of under
 * `CONNECTIONS_PENDING_KEY`. `settleConnectedService` knows this one
 * literal key so a credential settling still reaches that card, without
 * standing up a second, template-scoped settle function. */
const TEMPLATE_PENDING_CONNECTIONS_KEY = "template/pendingConnections";

const PendingConnections = type("string[]");

function pendingConnectionsAt(
  settings: Record<string, unknown>,
  key: string,
): readonly string[] {
  const parsed = PendingConnections(settings[key]);
  if (parsed instanceof type.errors) return [];
  return parsed;
}

export function pendingConnectionsOf(
  settings: Record<string, unknown>,
): readonly string[] {
  return pendingConnectionsAt(settings, CONNECTIONS_PENDING_KEY);
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
  const isSettled = (entry: string) => bareConnectorId(entry) === connected;
  for (const row of rows) {
    const pending = pendingConnectionsOf(row.settings);
    const templatePending = pendingConnectionsAt(
      row.settings,
      TEMPLATE_PENDING_CONNECTIONS_KEY,
    );
    const matchedPending = pending.some(isSettled);
    const matchedTemplatePending = templatePending.some(isSettled);
    if (!matchedPending && !matchedTemplatePending) continue;

    const settingsPatch: Record<string, unknown> = { ...row.settings };
    if (matchedPending) {
      settingsPatch[CONNECTIONS_PENDING_KEY] = pending.filter(
        (entry) => !isSettled(entry),
      );
    }
    if (matchedTemplatePending) {
      settingsPatch[TEMPLATE_PENDING_CONNECTIONS_KEY] = templatePending.filter(
        (entry) => !isSettled(entry),
      );
    }
    const updated = await deps.store.updateWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId: row.workbenchId,
      settings: settingsPatch,
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
