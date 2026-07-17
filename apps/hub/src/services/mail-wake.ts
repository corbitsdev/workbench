import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import type { MiddlewareHandler } from "hono";
import { getLogger } from "@intx/log";

const log = getLogger(["services", "mail-wake"]);

const { agentInstance } = intxSchema;

// Mail-only wake for slept agent instances. The idle-session reaper sleeps
// every idle agent kind, and nothing auto-wakes an instance — the ONLY wake
// triggers are the two inbound-message ingresses covered here:
//
//   1. HTTP mail sends (users and API callers) — `createMailWakeMiddleware`,
//      mounted ahead of interchange's `/:instanceId/mail` route, relaunches a
//      non-routable instance before that route dispatches to the sidecar.
//      (The chat surface additionally wakes via POST /instances/:id/sessions,
//      which is its own explicit launch call, not an auto-wake.)
//   2. Agent-to-agent mail — a sidecar-originated `mail.outbound` frame is
//      routed wire-side inside interchange (`handleMailOutbound`); a reaped
//      recipient is absent from the address index and not in the
//      disconnected queue, so the router emits `mail.outbound.undelivered`
//      and the orchestrator's default listener just logs and drops it.
//      `registerUndeliveredMailWake` subscribes the hub to that same event
//      (listeners are additive), relaunches any recipient that is a known
//      agent instance, and re-delivers the mail via the router's public
//      `routeMail` once the address is routable again.

/** The cold-start relaunch used for every wake; a no-op when the instance is
 * already routable (see `relaunchInstanceIfNeeded`). */
export type WakeInstance = (instanceId: string) => Promise<void>;

/**
 * Hono middleware: on an inbound mail POST, wake the target instance before
 * the downstream (interchange-owned) mail route runs. Awaited so the mail
 * route sees the relaunched, routable address; a relaunch failure is logged
 * and falls through to the mail route's own error handling rather than
 * blocking the request. Non-POST methods (the mail-list GET polls this same
 * path) pass straight through.
 */
export function createMailWakeMiddleware(
  wake: WakeInstance,
): MiddlewareHandler {
  return async (c, next) => {
    const instanceId = c.req.param("instanceId");
    if (instanceId && c.req.method === "POST") {
      await wake(instanceId).catch((err: unknown) => {
        // ERROR, not WARN: a failed cold-wake means the request falls through
        // to the mail route with the instance still unroutable, so the inbound
        // mail is dropped with no redelivery for this HTTP mail-send surface.
        // WARN never reaches Sentry (the sink forwards only error/fatal), which
        // hid this user-visible drop; surface it loudly instead.
        log.error(
          "mail-route wake relaunch failed; inbound mail may be dropped",
          {
            instanceId,
            error: err instanceof Error ? err : new Error(String(err)),
          },
        );
      });
    }
    await next();
  };
}

/** The subset of `SidecarRouter` the undelivered-mail wake needs. */
export interface UndeliveredMailWakeDeps {
  db: DB["db"];
  wake: WakeInstance;
  onUndelivered: (
    handler: (event: { rawMessage: string; recipients: string[] }) => void,
  ) => () => void;
  routeMail: (agentAddress: string, rawMessage: string) => boolean;
}

/**
 * Subscribe to the router's `mail.outbound.undelivered` notification and, for
 * every recipient that is a known agent-instance address, wake the instance
 * and re-deliver the mail. Recipients with no instance row (external
 * addresses, workflow-derived addresses) are left to the orchestrator's
 * default drop-and-log. Returns the unsubscribe handle.
 */
export function registerUndeliveredMailWake(
  deps: UndeliveredMailWakeDeps,
): () => void {
  async function wakeAndRedeliver(
    rawMessage: string,
    recipient: string,
  ): Promise<void> {
    const rows = await deps.db
      .select({ id: agentInstance.id })
      .from(agentInstance)
      .where(eq(agentInstance.address, recipient))
      .limit(1);
    const instanceId = rows[0]?.id;
    if (instanceId === undefined) return;

    await deps.wake(instanceId);
    const delivered = deps.routeMail(recipient, rawMessage);
    if (delivered) {
      log.info("woke slept instance for undelivered agent mail", {
        instanceId,
        recipient,
      });
    } else {
      log.warn("instance still unroutable after wake; agent mail dropped", {
        instanceId,
        recipient,
      });
    }
  }

  return deps.onUndelivered(({ rawMessage, recipients }) => {
    for (const recipient of recipients) {
      void wakeAndRedeliver(rawMessage, recipient).catch((err: unknown) => {
        log.warn("undelivered-mail wake failed", {
          recipient,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }
  });
}
