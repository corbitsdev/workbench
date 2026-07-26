import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { toleranceFailureContent } from "@workbench/shared";
import type { HubDb } from "../db";
import type { ContextToolEntry } from "../lib/tool-registry";
import {
  deliverInboxBatch,
  type InboxBatchDelivery,
  type InboxDeliverBatchResult,
} from "../lib/inbox-deliver-batch";

export const INBOX_DELIVER_BATCH_DEFINITION: ToolDefinition = {
  name: "inbox_deliver_batch",
  description:
    "Write optional artifacts and deliver one inbox message per recipient in a single hub call. Prefer this over looping write_artifact + mail_send — mail_send is turn-capped and re-runs would re-spam without messageKey. Each delivery is addressed by the recipient's `refId` (taken from the schedule's stored recipient list) and requires messageKey (mailbox idempotency). When artifact is set, artifact.sourceRef is required (artifact upsert key). A recipient whose refId no longer belongs to a member of this tenant is returned under `skipped` with a reason — not an error, and it does not stop the rest of the batch.",
  inputSchema: {
    type: "object",
    properties: {
      fromLocalPart: {
        type: "string",
        description:
          'Local-part for From: (e.g. "daily-linkedin" → daily-linkedin@domain).',
      },
      userAddress: {
        type: "string",
        description:
          "The firing member's usr_ mailbox. Supplies the mail domain for From: and for each recipient's address.",
      },
      deliveries: {
        type: "array",
        description: "One entry per recipient.",
        items: {
          type: "object",
          properties: {
            refId: {
              type: "string",
              description:
                "Recipient's auth refId, taken verbatim from the schedule's recipient list.",
            },
            subject: { type: "string" },
            body: { type: "string" },
            messageKey: {
              type: "string",
              description:
                "Idempotency key for the mailbox row. Same key = no re-mail.",
            },
            artifact: {
              type: "object",
              description: "Optional artifact to persist before mailing.",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
                kind: { type: "string" },
                sourceRef: {
                  type: "string",
                  description:
                    "Required when artifact is set. Tenant-scoped dedupe key.",
                },
                jobLabel: { type: "string" },
              },
              required: ["title", "body", "kind", "sourceRef"],
            },
          },
          required: ["refId", "subject", "body", "messageKey"],
        },
      },
    },
    required: ["fromLocalPart", "userAddress", "deliveries"],
  },
};

type InboxDeliverBatchContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
};

function parseDeliveries(value: unknown): InboxBatchDelivery[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("deliveries must be a non-empty array");
  }
  const out: InboxBatchDelivery[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("each delivery must be an object");
    }
    const row = entry as Record<string, unknown>;
    const { refId, subject, body, messageKey } = row;
    if (typeof refId !== "string" || refId.trim() === "") {
      throw new Error("deliveries[].refId is required");
    }
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new Error("deliveries[].subject is required");
    }
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error("deliveries[].body is required");
    }
    if (typeof messageKey !== "string" || messageKey.trim() === "") {
      throw new Error("deliveries[].messageKey is required");
    }

    const delivery: InboxBatchDelivery = {
      refId: refId.trim(),
      subject: subject.trim(),
      body: body.trim(),
      messageKey: messageKey.trim(),
    };
    if (row.artifact !== undefined) {
      if (typeof row.artifact !== "object" || row.artifact === null) {
        throw new Error("deliveries[].artifact must be an object");
      }
      const art = row.artifact as Record<string, unknown>;
      const title = art.title;
      const artBody = art.body;
      const kind = art.kind;
      const sourceRef = art.sourceRef;
      if (typeof title !== "string" || title.trim() === "") {
        throw new Error("artifact.title is required");
      }
      if (typeof artBody !== "string" || artBody.trim() === "") {
        throw new Error("artifact.body is required");
      }
      if (typeof kind !== "string" || kind.trim() === "") {
        throw new Error("artifact.kind is required");
      }
      if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
        throw new Error("artifact.sourceRef is required");
      }
      delivery.artifact = {
        title: title.trim(),
        body: artBody.trim(),
        kind: kind.trim(),
        sourceRef: sourceRef.trim(),
      };
      if (typeof art.jobLabel === "string" && art.jobLabel.trim() !== "") {
        delivery.artifact.jobLabel = art.jobLabel.trim();
      }
    }
    out.push(delivery);
  }
  return out;
}

/**
 * The outer `ToolResult.isError` is never set, on any path.
 *
 * Today this tool is agent-dispatched, where a thrown handler error is just a
 * failed call the agent reasons past. But a future workflow could dispatch it
 * from a native `action`, and `runDeterministicToolStep` throws unconditionally
 * on a true outer `isError`, killing the run. So a call that cannot run at all
 * (a malformed argument object) comes back as a SUCCESSFUL result whose content
 * carries `{ isError: true, error }` — `@workbench/shared`'s shared tolerance
 * envelope — and a per-recipient problem comes back inside the normal result
 * under `skipped` / `errors`. The failure is legible either way (CL-4429).
 */
export function createInboxDeliverBatchTools(
  context: InboxDeliverBatchContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: INBOX_DELIVER_BATCH_DEFINITION,
      handler: async (args) => {
        try {
          const fromLocalPart = args.fromLocalPart;
          const userAddress = args.userAddress;
          if (
            typeof fromLocalPart !== "string" ||
            fromLocalPart.trim() === ""
          ) {
            throw new Error("fromLocalPart is required");
          }
          if (typeof userAddress !== "string" || userAddress.trim() === "") {
            throw new Error("userAddress is required");
          }

          const result: InboxDeliverBatchResult = await deliverInboxBatch(
            context.db,
            {
              tenantId: context.tenantId,
              actorPrincipalId: context.principalId,
              fromLocalPart: fromLocalPart.trim(),
              userAddress: userAddress.trim(),
              deliveries: parseDeliveries(args.deliveries),
            },
          );
          return JSON.stringify(result, null, 2);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return JSON.stringify(toleranceFailureContent(message), null, 2);
        }
      },
    },
  ];
}

export const INBOX_DELIVER_BATCH_HUB_TOOLS: Record<string, ContextToolEntry> = {
  inbox_deliver_batch: {
    definition: INBOX_DELIVER_BATCH_DEFINITION,
    sideEffect: "write",
    createTools: (ctx) =>
      createInboxDeliverBatchTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
        principalId: ctx.principalId,
      }),
  },
};
