// The platform call surface `@corbits/chat` needs from its host:
// launching an interactive channel instance, sending and listing its
// mail, fetching attachment blobs, and subscribing to its live event
// stream. The hub builds this from the same `SessionService`/db calls
// `createInstanceRoutes` uses (see `vendor/intx/hub-api/src/routes/instances.ts`),
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
// on `ChannelMail` alone. `ChatPlatform` remains the composed
// convenience type the hub actually implements and injects.
import type { MailContent } from "./codec";

export interface LaunchedChannel {
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
 * Per-channel activity a channel-list row can honestly show: the
 * newest message's timestamp, and how many messages postdate the
 * caller's read cursor. `lastActivityAt` is omitted (not zero, not a
 * guess) when a channel has no messages, or when its mailbox cannot be
 * resolved at all (see `listChannelActivity`) — a row with no signal
 * renders no signal, never an invented one.
 */
export interface ChannelActivitySummary {
  readonly lastActivityAt?: string;
  readonly unreadCount: number;
  /** A bounded, text-only snippet of the newest message — omitted (never
   * an empty string) when there is no message yet, or when the newest
   * message carries no text part. */
  readonly preview?: string;
}

export interface ChatChannelEvent {
  readonly type: string;
  readonly data: unknown;
}

/** Launching a channel host and inviting an already-deployed agent
 * into one. */
export interface ChannelLauncher {
  launchChannel(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly channelId: string;
    readonly triggerAddress: string;
    readonly definition: string;
  }): Promise<LaunchedChannel>;

  /**
   * Launches an interactive instance of an already-deployed workflow
   * definition — the invited agent's own run, distinct from the
   * channel's own anchor run — and returns its mail address. Uses the
   * same `deployInstanceAtHead` machinery `launchChannel` uses for the
   * host, sharing its launch core; only the source of the launch body
   * (an existing definition id vs. a freshly synthesized one) differs.
   */
  launchInvite(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly definitionId: string;
  }): Promise<LaunchedInvite>;

  /**
   * Lists the tenant's deployed, launchable workflow definitions an
   * "invite agent" affordance can offer — never including a channel's
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
    channelId: string,
    address: string,
  ): Promise<void>;
}

/**
 * Thrown by `ChannelMail.sendMail` when the target agent's address
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

/** Sending and reading a channel's mail, and fetching its attachment
 * blobs. */
export interface ChannelMail {
  sendMail(input: {
    readonly tenantId: string;
    readonly channelId: string;
    /**
     * The sending principal, when the send is a human/participant
     * message — the address it sends from is derived as
     * `${principalId}@<channel's domain>`. Omit when `fromChannelId`
     * is given instead; exactly one of the two must be present, and
     * the adapter throws loud if neither is.
     */
    readonly principalId?: string;
    readonly content: MailContent;
    /**
     * Send the mail from another channel's address instead of the
     * principal's. Fan-out copies to mentioned agents, and the chat
     * orchestrator's posted replies, carry the origin channel here: an
     * agent's reply router answers the From address of the mail it
     * received, and a principal address has no mailbox — a reply to it
     * vanishes. From-the-channel means agents answer into the mailbox
     * every participant reads.
     */
    readonly fromChannelId?: string;
  }): Promise<SentMail>;

  listMail(input: {
    readonly tenantId: string;
    readonly channelId: string;
    readonly cursor?: string;
  }): Promise<ListedMail>;

  /**
   * Resolves a single message by id directly, rather than paging
   * through `listMail` and scanning each page for it — a message
   * older than one page back must still be findable, not silently
   * invisible to a caller (a reaction/pin toggle, say) that only knows
   * its id. Undefined when no message with that id exists in this
   * channel's mailbox.
   */
  getMail(input: {
    readonly tenantId: string;
    readonly channelId: string;
    readonly messageId: string;
  }): Promise<ListedMailItem | undefined>;

  /**
   * Bulk activity signals for a channel list — one call covering every
   * row, never one `listMail` per channel. `sinceCreatedAt` is the
   * caller's own read cursor for that channel (from
   * `channel_read_state`), omitted for a channel the caller has never
   * opened, in which case every message counts as unread. The result
   * is keyed by `channelId`; a channel whose mailbox cannot be
   * resolved (no session behind it yet) is simply absent from the
   * result rather than reported with a fabricated zero.
   */
  listChannelActivity(input: {
    readonly tenantId: string;
    readonly channels: readonly {
      readonly channelId: string;
      readonly sinceCreatedAt?: string;
    }[];
  }): Promise<Record<string, ChannelActivitySummary>>;

  fetchBlob(channelId: string, blobId: string): Promise<string | Uint8Array>;
}

/** Subscribing to a channel's live event stream. */
export interface ChannelEvents {
  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatChannelEvent) => void,
  ): () => void;
}

/**
 * The composed port the hub actually implements and injects. Handlers
 * and services that only need one seam should depend on that
 * interface directly (`ChannelMail`, say) rather than the full
 * composition — this type exists for the hub's own implementation and
 * for wiring that genuinely spans all three.
 */
export type ChatPlatform = ChannelLauncher & ChannelMail & ChannelEvents;
