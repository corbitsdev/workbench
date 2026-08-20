// The platform call surface `@corbits/chat` needs from its host:
// launching an interactive workbench instance, sending and listing its
// mail, fetching attachment blobs, and subscribing to its live event
// stream. The hub builds this from the same `SessionService`/db calls
// `createRunRoutes` uses (see `vendor/intx/hub-api/src/routes/runs.ts`),
// but that machinery — grant materialization, credential resolution,
// model-source resolution, multi-table transactions — is internal
// wiring specific to the hub, not a single callable service. Rather
// than duplicating it inside this package (which would violate "apps
// stay generic; packages own the domain" the other way around), this
// package depends on this narrow port, injected by the hub exactly as
// `@workbench/onboarding` injects `pushWorkflow` instead of
// reimplementing workflow push.
//
// Split into its three real seams — launching, mail, and the live
// event stream — rather than one flat interface, so a call site that
// only ever sends and lists mail (the fan-out service, say) can depend
// on `WorkbenchMail` alone. `ChatPlatform` remains the composed
// convenience type the hub actually implements and injects.
import type { MailContent } from "./codec";

export interface LaunchedWorkbench {
  readonly instanceId: string;
}

export interface LaunchedInvite {
  readonly instanceId: string;
  readonly address: string;
}

export interface InvitableDefinition {
  readonly id: string;
  readonly name: string;
  /** The definition's human display name (e.g. "Myra" for the
   * `assistant` asset); absent when the deploy carried none. */
  readonly description?: string;
}

export interface SentMail {
  readonly id: string;
  readonly createdAt: string;
}

export interface ListedMailItem {
  readonly id: string;
  readonly createdAt: string;
  readonly mail: unknown;
}

export interface ListedMail {
  readonly items: readonly ListedMailItem[];
  readonly nextCursor?: string;
}

/**
 * Per-workbench activity a workbench-list row can honestly show: the
 * newest message's timestamp, and how many messages postdate the
 * caller's read cursor. `lastActivityAt` is omitted (not zero, not a
 * guess) when a workbench has no messages, or when its mailbox cannot be
 * resolved at all (see `listWorkbenchActivity`) — a row with no signal
 * renders no signal, never an invented one.
 */
export interface WorkbenchActivitySummary {
  readonly lastActivityAt?: string;
  readonly unreadCount: number;
  /** A bounded, text-only snippet of the newest message — omitted (never
   * an empty string) when there is no message yet, or when the newest
   * message carries no text part. */
  readonly preview?: string;
}

export interface ChatWorkbenchEvent {
  readonly type: string;
  readonly data: unknown;
}

/** Launching a workbench host and inviting an already-deployed agent
 * into one. */
export interface WorkbenchLauncher {
  /**
   * Mints the workbench host's own run — DB rows only, addressable but
   * not yet deployed. The host deploys through the platform's wake
   * choke point on its first traffic, so this returns in database
   * time; a caller that wants the deploy started ahead of traffic
   * pre-warms with `ensureAwake`.
   */
  launchWorkbench(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly workbenchId: string;
    readonly triggerAddress: string;
    readonly definition: string;
  }): Promise<LaunchedWorkbench>;

  /**
   * Mints an interactive instance of an already-deployed workflow
   * definition — the invited agent's own run, distinct from the
   * workbench's own anchor run — and returns its mail address. Like
   * `launchWorkbench`, this writes DB rows only; the instance deploys
   * on its first inbound mail or an explicit `ensureAwake` pre-warm.
   */
  launchInvite(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly definitionId: string;
  }): Promise<LaunchedInvite>;

  /**
   * Deploys the run behind `address` if it is not currently routable —
   * the same wake `sendMail` performs implicitly before delivering.
   * Used to pre-warm a freshly minted (or slept) instance ahead of the
   * traffic that would otherwise pay the deploy inline. Concurrent
   * calls for one address coalesce onto a single deploy.
   */
  ensureAwake(address: string): Promise<void>;

  /**
   * Lists the tenant's deployed, launchable workflow definitions an
   * "invite agent" affordance can offer — never including a workbench's
   * own host definition.
   */
  listInvitableDefinitions(
    tenantId: string,
  ): Promise<readonly InvitableDefinition[]>;

  /**
   * Resolves an already-joined participant's address back to the
   * definition id it was launched from — the reverse of `launchInvite`.
   * Returns undefined for an address this platform has no folded run
   * for (a human participant, or a stale/removed agent).
   */
  resolveDefinitionIdByAddress(address: string): Promise<string | undefined>;

  /**
   * Recomputes an already-invited instance's folded launch body from
   * its definition's CURRENT asset content, and persists it so the
   * instance's next wake uses it. A wake replays whatever the launch
   * store holds verbatim — it never re-reads the definition's asset
   * itself — so an edited system prompt only reaches a running
   * instance through this seam. A no-op, never throwing, for an
   * address with no running instance behind it.
   */
  refreshAgentInstanceFromDefinition(
    tenantId: string,
    workbenchId: string,
    address: string,
  ): Promise<void>;
}

/**
 * Thrown by `WorkbenchMail.sendMail` when the target agent's address
 * never became routable — the sidecar-side agent is (or remains)
 * unreachable even after the adapter's own reclaim-settle retries and
 * redeploy fallback. Callers distinguish this from every other
 * `sendMail` failure (bad input, definition errors, …) to answer with
 * a clean, retriable "come back in a moment" response instead of an
 * unhandled 500.
 */
export class AgentUnreachableError extends Error {
  constructor(address: string, options?: { cause?: unknown }) {
    super(`Agent at "${address}" is unreachable`, options);
    this.name = "AgentUnreachableError";
  }
}

/** Sending and reading a workbench's mail, and fetching its attachment
 * blobs. */
export interface WorkbenchMail {
  sendMail(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    /**
     * The sending principal, when the send is a human/participant
     * message — the address it sends from is derived as
     * `${principalId}@<workbench's domain>`. Omit when `fromWorkbenchId`
     * is given instead; exactly one of the two must be present, and
     * the adapter throws loud if neither is.
     */
    readonly principalId?: string;
    readonly content: MailContent;
    /**
     * Send the mail from another workbench's address instead of the
     * principal's. Fan-out copies to mentioned agents, and the chat
     * orchestrator's posted replies, carry the origin workbench here: an
     * agent's reply router answers the From address of the mail it
     * received, and a principal address has no mailbox — a reply to it
     * vanishes. From-the-workbench means agents answer into the mailbox
     * every participant reads.
     */
    readonly fromWorkbenchId?: string;
  }): Promise<SentMail>;

  listMail(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly cursor?: string;
  }): Promise<ListedMail>;

  /**
   * Resolves a single message by id directly, rather than paging
   * through `listMail` and scanning each page for it — a message
   * older than one page back must still be findable, not silently
   * invisible to a caller (a reaction/pin toggle, say) that only knows
   * its id. Undefined when no message with that id exists in this
   * workbench's mailbox.
   */
  getMail(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly messageId: string;
  }): Promise<ListedMailItem | undefined>;

  /**
   * Bulk activity signals for a workbench list — one call covering every
   * row, never one `listMail` per workbench. `sinceCreatedAt` is the
   * caller's own read cursor for that workbench (from
   * `workbench_read_state`), omitted for a workbench the caller has never
   * opened, in which case every message counts as unread. The result
   * is keyed by `workbenchId`; a workbench whose mailbox cannot be
   * resolved (no session behind it yet) is simply absent from the
   * result rather than reported with a fabricated zero.
   */
  listWorkbenchActivity(input: {
    readonly tenantId: string;
    readonly workbenches: readonly {
      readonly workbenchId: string;
      readonly sinceCreatedAt?: string;
    }[];
  }): Promise<Record<string, WorkbenchActivitySummary>>;

  fetchBlob(workbenchId: string, blobId: string): Promise<string | Uint8Array>;
}

/** Subscribing to a workbench's live event stream. */
export interface WorkbenchEvents {
  subscribeToWorkbench(
    workbenchId: string,
    onEvent: (event: ChatWorkbenchEvent) => void,
  ): () => void;
}

/**
 * The composed port the hub actually implements and injects. Handlers
 * and services that only need one seam should depend on that
 * interface directly (`WorkbenchMail`, say) rather than the full
 * composition — this type exists for the hub's own implementation and
 * for wiring that genuinely spans all three.
 */
export type ChatPlatform = WorkbenchLauncher & WorkbenchMail & WorkbenchEvents;
