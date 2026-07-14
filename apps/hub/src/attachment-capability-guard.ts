import type { MiddlewareHandler } from "hono";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { schema as intxSchema, parseAgentRow, type DB } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  acceptedMimeTypes,
  templateAttachmentCapability,
} from "@workbench/catalog";

const log = getLogger("attachment-capability-guard");

// We only need the attachment MIME types off the mail body; the downstream
// interchange route owns full SendMessage validation.
const GuardedMailBody = type({
  "content?": "string",
  "attachments?": type({ mimeType: "string" }).array(),
});

/**
 * The MIME set an agent DEFINITION can actually consume — narrowed to what its
 * inference adapter marshals — or `null` when it can't be determined (no
 * classifiable inference credential / model). Shared by the composer's
 * per-instance guard below and the mailbox triage inbound-attachment divert
 * (`mailbox-attachment-divert.ts`), which resolves the recipient's agent
 * definition directly rather than through an instance.
 */
export function acceptedMimeTypesForAgentRow(
  agentRow: typeof intxSchema.agent.$inferSelect,
): string[] | null {
  const parsed = parseAgentRow(agentRow);
  try {
    const capability = templateAttachmentCapability({
      key: agentRow.id,
      credentialRequirements: parsed.credentialRequirements ?? [],
      ...(parsed.modelConfig !== null
        ? { modelConfig: parsed.modelConfig }
        : {}),
    });
    return acceptedMimeTypes(capability);
  } catch {
    // No tenant inference credential or no defaultModel — can't classify the
    // adapter, so we can't safely narrow. Defer.
    return null;
  }
}

/**
 * The MIME set the agent bound to `instanceId` can actually consume — see
 * `acceptedMimeTypesForAgentRow`. A `null` defers to the system-level
 * validation downstream rather than block a legitimate send on an infra
 * hiccup.
 */
export async function resolveInstanceAcceptedMimeTypes(
  db: DB["db"],
  instanceId: string,
): Promise<string[] | null> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(intxSchema.agentInstance.id, instanceId),
  });
  if (!instance) return null;
  const agentRow = await db.query.agent.findFirst({
    where: eq(intxSchema.agent.id, instance.agentId),
  });
  if (!agentRow) return null;
  return acceptedMimeTypesForAgentRow(agentRow);
}

/**
 * Server-side backstop for the composer's per-agent attachment gate. The client
 * narrows the accepted set per agent, but the interchange mail route only
 * validates against the system-wide allowlist — so a disallowed attachment
 * reaching an instance by any other path would become a document ContentBlock
 * and throw in the openai-compatible adapter at inference time. This rejects it
 * at the edge, before the message is stored. Mounted as middleware on the mail
 * route so the send path and its recovery stay untouched.
 */
export function createAttachmentCapabilityGuard(
  db: DB["db"],
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();

    let body: unknown;
    try {
      // Read a clone so the original body stream stays intact for the
      // downstream interchange handler.
      body = await c.req.raw.clone().json();
    } catch {
      return next();
    }
    const parsed = GuardedMailBody(body);
    if (parsed instanceof type.errors) return next();
    const attachments = parsed.attachments ?? [];
    if (attachments.length === 0) return next();

    const instanceId = c.req.param("instanceId");
    if (instanceId === undefined) return next();

    let accepted: string[] | null;
    try {
      accepted = await resolveInstanceAcceptedMimeTypes(db, instanceId);
    } catch (err) {
      log.warn(
        "attachment capability resolution failed; deferring to system validation",
        { instanceId, error: err },
      );
      return next();
    }
    if (accepted === null) return next();

    const disallowed = [
      ...new Set(
        attachments
          .filter((a) => !accepted.includes(a.mimeType))
          .map((a) => a.mimeType),
      ),
    ];
    if (disallowed.length > 0) {
      return c.json(
        {
          error: {
            code: "disallowed_for_agent",
            message: `This agent can't process ${disallowed.join(", ")}.`,
          },
        },
        422,
      );
    }
    return next();
  };
}
