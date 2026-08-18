// Chat workspace: the host resolves which bench the signed-in
// account chats in, loads its workbenches and deployed agents, and wires the
// timeline and composer together for whichever workbench is
// selected. Workbench list lives in the shell contextual panel — this
// surface is the active conversation only.
//
// Resolving *which* bench that is is host-specific (it rides on
// whatever session/query plumbing the embedding app already has — in
// `@workbench/web` that is the same `/api/me/principals` call the Home
// and Settings pages use), so `ChatWorkspace` takes a small
// `TenantResolution` value rather than importing app code: the same
// narrow-port shape `@corbits/chat`'s `routes.ts` uses for `ChatPlatform`.

import { UnauthenticatedError } from "@corbits/api-query";
import { isAgentAddress } from "@corbits/chat/mentions";
import { Button, EmptyState, Skeleton, toast } from "@corbits/react-ui";
import {
  ChartColumn,
  ChevronDown,
  CircleAlert,
  MessageSquare,
  Repeat,
  SlidersHorizontal,
  UserPlus,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  ChatApiError,
  workbenchesQueryKey,
  workbenchesQueryKeyPrefix,
  describeChatError,
  forkThread,
  inviteAgent,
  listWorkbenches,
  listInvitableDefinitions,
  listMessages,
  listPinnedMessages,
  listThreadMessages,
  listThreads,
  pinMessage,
  putReadState,
  sendMessage,
  toggleReaction,
  unpinMessage,
  workbenchStreamUrl,
  isKnownWorkbenchKind,
} from "./api";
import type {
  Workbench,
  WorkbenchThread,
  MessageItem,
  ParticipantRecord,
  Part,
  PinnedMessage,
} from "./api";
import { WorkbenchSettingsSurface } from "./workbench-settings";
import type { WorkbenchSettingsSectionId } from "./workbench-settings";
import { Composer, partsForSend } from "./composer";
import type {
  ComposerAttachment,
  ComposerHandle,
  ComposerSendPayload,
} from "./composer";
import { InviteAgentDialog } from "./invite-agent-dialog";
import { mentionCandidatesFromParticipants } from "./mentions";
import type { BringInMember, MentionInviteIntent } from "./mentions";
import { PinnedStrip } from "./pinned-strip";
import { CHAT_STRINGS } from "./strings";
import { useStreamingReply, typingAgentNames } from "./streaming-reply";
import { useTurnActivity, TurnActivityStrip } from "./turn-activity";
import type { StreamingReplyState } from "./streaming-reply";
import { AgentBadge, WorkbenchTimeline, messageDomId } from "./timeline";
import type {
  CurrentUser,
  PendingMessageStatus,
  PinActions,
  ReactionActions,
  ScrollSnapshot,
  ThreadAffordanceMeta,
  TimelineMessageItem,
} from "./timeline";
import type { ApprovalActions } from "./blocks/approval-actions";
import type { BlockResponseActions } from "./blocks/block-responses";
import {
  typingLabel,
  TypingIndicator,
  AgentTypingIndicator,
  useTypingIndicator,
} from "./typing-indicator";
import type { ProfileSubject } from "./profile-subject";
import { useWorkbenchStream } from "./use-workbench-stream";

/**
 * The host's answer to "which bench does this account chat in": mirrors
 * the loading/unauthenticated/error/ready shape every hub-backed query
 * in the embedding app already uses, plus `"empty"` for an
 * authenticated account with no bench membership at all.
 */
export type TenantResolution =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly tenantId: string };

/**
 * One live presence entry for the workbench's who's-here stack — deliberately
 * a plain data shape, not `@corbits/presence`'s own type: this package
 * never depends on presence, the same way it never depends on any other
 * domain package it's merely handed data from. The host composes the real
 * connection (`@corbits/presence/client`) and passes the current snapshot
 * down as `presenceMembers`.
 */
export interface PresenceMember {
  readonly principalId: string;
  readonly displayName: string;
  readonly color: string;
}

/** One entry in the header's combined who's-active stack — an agent
 * participant or a live human, normalized to the one shape the stack
 * renders regardless of source. */
export interface TeamAvatarEntry {
  readonly key: string;
  readonly initials: string;
  readonly label: string;
  readonly tone: "agent" | "neutral";
  readonly color?: string;
}

/** How many avatars the header shows before collapsing the rest into a
 * "+N" chip. */
export const TEAM_AVATAR_STACK_LIMIT = 6;

/**
 * Every currently-active member of the workbench, for the header's
 * overlapping avatar stack: every agent participant on the workbench (agents
 * are always "active" — they have no presence concept of their own) plus
 * every human currently reflected in live presence. Agents first since
 * they're a workbench's stable roster; humans are who's here right now.
 */
export function buildTeamAvatarStack(
  participants: readonly ParticipantRecord[],
  presenceMembers: readonly PresenceMember[],
): readonly TeamAvatarEntry[] {
  const agents = participants
    .filter((participant) => isAgentAddress(participant.address))
    .map((participant) => ({
      key: participant.address,
      initials: participant.handle,
      label: participant.handle,
      tone: "agent" as const,
    }));
  const humans = presenceMembers.map((member) => ({
    key: member.principalId,
    initials: member.displayName.slice(0, 1).toUpperCase(),
    label: member.displayName,
    tone: "neutral" as const,
    color: member.color,
  }));
  return [...agents, ...humans];
}

type WorkbenchesState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly Workbench[];
      readonly chats: readonly Workbench[];
    };

export type MessagesState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "error";
      readonly message: string;
      /** The workbench itself 404s, not just this load — retrying with the
       * same id can never succeed, so the UI trades "Try again" for an
       * honest way out instead. */
      readonly workbenchNotFound: boolean;
      /** A 401 means the session itself is gone — "Try again" would hit
       * the same 401 forever, so the UI offers a way to sign back in
       * instead of a retry that can never succeed. */
      readonly isUnauthorized: boolean;
    }
  | { readonly kind: "ready"; readonly items: readonly MessageItem[] };

export type MessagesLoadOutcome =
  | { readonly kind: "success"; readonly items: readonly MessageItem[] }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly workbenchNotFound: boolean;
      readonly isUnauthorized: boolean;
    };

/**
 * A background refresh (SSE/poll) never shows the loading skeleton and
 * never replaces a `ready` timeline with an error page — it only ever moves
 * `ready` state forward on success, and otherwise leaves whatever was on
 * screen untouched. A foreground load (first load or workbench switch)
 * always reflects the outcome directly.
 */
export function nextMessagesState(
  current: MessagesState,
  outcome: MessagesLoadOutcome,
  background: boolean,
): MessagesState {
  if (outcome.kind === "success") {
    return { kind: "ready", items: outcome.items };
  }
  if (background) return current;
  return {
    kind: "error",
    message: outcome.message,
    workbenchNotFound: outcome.workbenchNotFound,
    isUnauthorized: outcome.isUnauthorized,
  };
}

/**
 * A chat's agent is fixed at creation — the server 409s an invite into one
 * — so the "invite agent" affordance only ever makes sense on a workbench or
 * on a kind this UI doesn't otherwise recognize. Undefined (no workbench
 * resolved yet) defaults to showing it.
 */
export function canInviteAgent(kind: string | undefined): boolean {
  if (kind === undefined) return true;
  return !isKnownWorkbenchKind(kind) || kind !== "chat";
}

/**
 * The composer's placeholder reads as a direct message once the active
 * surface is a chat, naming its one counterpart — a chat's title always
 * defaults to that counterpart's name at creation (see `routes.ts`'s
 * `POST /workbenches`), so it's always the right word here even when the
 * counterpart is a person, not an agent. A workbench (or a surface that
 * hasn't resolved yet) keeps the generic, mention-driven copy.
 */
export function composerPlaceholderFor(
  workbench:
    | {
        readonly kind: string;
        readonly title: string;
      }
    | undefined,
): string {
  if (workbench === undefined || workbench.kind !== "chat") {
    return CHAT_STRINGS.composerPlaceholder;
  }
  const counterpart =
    workbench.title.trim().length > 0
      ? workbench.title
      : CHAT_STRINGS.unnamedWorkbench;
  return CHAT_STRINGS.composerPlaceholderChat(counterpart);
}

/**
 * Which message source the timeline should load for the current view.
 *
 * - Open reply/delivery thread → that thread's membership only
 * - Brand-new reply (pending parent, no thread yet) → empty
 * - Workbench root feed → the workbench's root thread only (never full workbench
 *   mail, which mixes reply-thread messages into the root timeline)
 * - Threads API unavailable (empty rootThreadId) → full mailbox fallback
 */
export type MessageFeedTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "empty" }
  | { readonly kind: "root-thread"; readonly rootThreadId: string }
  | { readonly kind: "workbench-mail" };

export function resolveMessageFeedTarget(args: {
  readonly openThreadId: string | null;
  readonly pendingParentMessageId: string | null;
  readonly rootThreadId: string | null;
}): MessageFeedTarget {
  if (args.openThreadId !== null) {
    return { kind: "thread", threadId: args.openThreadId };
  }
  if (args.pendingParentMessageId !== null) {
    return { kind: "empty" };
  }
  if (args.rootThreadId !== null && args.rootThreadId !== "") {
    return { kind: "root-thread", rootThreadId: args.rootThreadId };
  }
  return { kind: "workbench-mail" };
}

function sortMessagesOldestFirst(items: readonly MessageItem[]): MessageItem[] {
  return [...items].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * A composer submit this workspace has optimistically added to the
 * timeline before the server confirms it — see `TimelineMessageItem`'s
 * `pendingStatus`. `nonce` is this workspace's own client-side key,
 * independent of any server-issued message id (which does not exist yet
 * while `status` is `"sending"`, and never will if it ends up discarded).
 */
export type PendingSend = {
  readonly nonce: string;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly status: PendingMessageStatus;
  /** The "Bring in…" picks this submit carried — kept on the pending
   * entry so a Retry re-runs the same pre-invite step the original
   * submit did. */
  readonly invite?: readonly MentionInviteIntent[];
};

let pendingSendSeq = 0;

/** A fresh client-side nonce for one composer submit — exported so tests
 * can reset the counter between cases without reaching into module
 * internals. */
export function resetPendingSendNonceForTests(): void {
  pendingSendSeq = 0;
}

/** Random per-page-load prefix: a pending nonce doubles as the message's
 * wire `clientId` (CL-6251), which the server persists — a bare counter
 * would repeat `pending_1` on every reload, colliding with a prior
 * session's stored clientId in the same workbench (wrong-message matches
 * in `mergePendingSends`, duplicate React keys in `WorkbenchTimeline`). */
const pendingSendSession = Math.random().toString(36).slice(2, 10);

function nextPendingSendNonce(): string {
  pendingSendSeq += 1;
  return `pending_${pendingSendSession}_${pendingSendSeq}`;
}

/** The sender address a pending send's synthetic item renders under —
 * `senderDisplay` (`timeline.tsx`) matches its local part against
 * `currentUser.principalId` to render "You" regardless of domain, so the
 * `@pending.local` half is never load-bearing, only honest about the
 * item not being server-issued yet. Shared with `sendPending`'s own
 * synchronous insert (`chat-workspace.tsx`) so a message never changes
 * sender identity mid-flight. */
export function pendingSenderAddress(
  currentUserPrincipalId: string | undefined,
): string {
  return `${currentUserPrincipalId ?? "you"}@pending.local`;
}

/**
 * Folds this workspace's own still-in-flight sends onto the end of the
 * server's message list, oldest-first like the rest of the timeline —
 * one message list, rendered through the exact same path as any
 * confirmed message (`WorkbenchTimeline`'s `MessageParts`), never a
 * separate visually-distinct tier. `pendingStatus`/`pendingNonce` are
 * the only markers that distinguish it: a small "sending" clock glyph,
 * or (once failed) an inline retry row — see `TimelineMessageItem`.
 *
 * A pending send's `nonce` doubles as the `clientId` it sent on the wire
 * (see `sendPending`) and is carried onto the synthetic item's own
 * `clientId` too, so it keys identically to whichever confirmed message
 * later reconciles it — `WorkbenchTimeline` renders both under the same
 * React key, updating one DOM node in place rather than unmounting a
 * pending bubble and mounting an unrelated confirmed one.
 *
 * Once `items` contains a confirmed message carrying that same
 * `clientId` (from the POST response landing, or from a later `GET
 * .../messages` page — whichever arrives first), the pending entry is
 * identity-matched and dropped here rather than rendered alongside its
 * own confirmed copy. This is never a heuristic guess from
 * content/timing; a message with no `clientId` at all (sent before this
 * feature, or by a peer) never matches any pending entry.
 */
export function mergePendingSends(
  items: readonly MessageItem[],
  pendingSends: readonly PendingSend[],
  currentUserPrincipalId: string | undefined,
): readonly TimelineMessageItem[] {
  if (pendingSends.length === 0) return items;
  const confirmedClientIds = new Set(
    items
      .map((item) => item.clientId)
      .filter((clientId): clientId is string => clientId !== undefined),
  );
  const unresolvedSends = pendingSends.filter(
    (pending) => !confirmedClientIds.has(pending.nonce),
  );
  if (unresolvedSends.length === 0) return items;
  const senderAddress = pendingSenderAddress(currentUserPrincipalId);
  const pendingItems: TimelineMessageItem[] = unresolvedSends.map(
    (pending) => ({
      id: pending.nonce,
      createdAt: pending.createdAt,
      parts: partsForSend(pending.text, pending.attachments),
      sender: { name: null, address: senderAddress },
      clientId: pending.nonce,
      pendingStatus: pending.status,
      pendingNonce: pending.nonce,
    }),
  );
  return [...items, ...pendingItems];
}

/** The one client-side id `mergeStreamingReply` gives its synthetic
 * timeline item — stable across renders (React's reconciliation key) and
 * never mistaken for a server-issued message id (those come back from
 * `POST`/`GET` routes with a different shape). */
const STREAMING_REPLY_ITEM_ID = "streaming_reply";

/**
 * Folds the active turn's in-progress reply onto the end of the timeline,
 * exactly the way `mergePendingSends` folds this reader's own optimistic
 * sends — except this synthetic item is the *other* side's message, so it
 * needs a sender to attribute it to. `chat.agent` events carry no sender
 * (the raw `InferenceEvent` union has no such field, see
 * `streaming-reply.ts`), so this picks the workbench's first agent
 * participant as the best available attribution; workbenches with more than
 * one invited agent are a known approximation here, not a regression —
 * today's non-streaming refetch has the same "which agent replied" gap
 * until the persisted message's real sender lands.
 */
export function mergeStreamingReply(
  items: readonly TimelineMessageItem[],
  streamingReply: StreamingReplyState,
  participants: readonly ParticipantRecord[],
): readonly TimelineMessageItem[] {
  // A pending reply with no tokens yet stays off the timeline — an
  // empty bubble with no timestamp reads as broken; the typing line
  // above the composer owns that phase until the first delta lands.
  if (streamingReply === null || streamingReply.text === "") return items;
  const agent = participants.find((participant) =>
    isAgentAddress(participant.address),
  );
  if (agent === undefined) return items;
  return [
    ...items,
    {
      id: STREAMING_REPLY_ITEM_ID,
      createdAt: new Date().toISOString(),
      parts: [{ kind: "text", text: streamingReply.text }],
      sender: { name: null, address: agent.address },
      streaming: true,
    },
  ];
}

/** The client-side id the reply-timeout notice renders under — same
 * "never a server-issued id" contract as `STREAMING_REPLY_ITEM_ID`. */
const REPLY_TIMED_OUT_ITEM_ID = "reply_timed_out_notice";

/**
 * Appends an honest inline notice once `useStreamingReply`'s own backstop
 * (`PENDING_REPLY_CLEAR_MS`) has fired — a turn that opened but never got a
 * single token and never closed out either, so the reader was left staring
 * at a typing indicator that just vanished with no explanation. Renders
 * through the same event-line path `mergeStreamingReply`'s bubble and every
 * other system line already use — no new CSS, no new item shape.
 */
export function appendReplyTimedOutNotice(
  items: readonly TimelineMessageItem[],
  replyTimedOut: boolean,
): readonly TimelineMessageItem[] {
  if (!replyTimedOut) return items;
  return [
    ...items,
    {
      id: REPLY_TIMED_OUT_ITEM_ID,
      createdAt: new Date().toISOString(),
      parts: [{ kind: "event", event: "chat.reply-timed-out", data: {} }],
      sender: { name: null, address: "" },
    },
  ];
}

/**
 * Records one workbench's scroll snapshot into the map, pure — a fresh `Map`
 * copy rather than a mutation, so `scrollSnapshotsRef.current` always holds
 * exactly the value this function returned, never a same-reference object
 * mutated out from under a caller still holding the old one.
 */
export function withScrollSnapshot(
  snapshots: ReadonlyMap<string, ScrollSnapshot>,
  workbenchId: string,
  snapshot: ScrollSnapshot,
): ReadonlyMap<string, ScrollSnapshot> {
  const next = new Map(snapshots);
  next.set(workbenchId, snapshot);
  return next;
}

/**
 * Workbenches and chats via TanStack Query, keyed with `workbenchesQueryKey` —
 * the same key `apps/web`'s shell bands and command palette use, so this
 * sidebar shares one in-flight fetch per (tenantId, kind) with the rest of
 * the shell rather than firing its own independent request on every mount.
 */
function useWorkbenchLists(tenantId: string) {
  const workbenches = useQuery({
    queryKey: workbenchesQueryKey(tenantId, "workbench"),
    queryFn: () => listWorkbenches(tenantId, "workbench"),
  });
  const chats = useQuery({
    queryKey: workbenchesQueryKey(tenantId, "chat"),
    queryFn: () => listWorkbenches(tenantId, "chat"),
  });

  const reload = useCallback(async () => {
    await Promise.all([workbenches.refetch(), chats.refetch()]);
  }, [workbenches.refetch, chats.refetch]);

  // Referentially stable across renders that don't actually change the
  // underlying data — a fresh object literal here every render would make
  // `workbenchesState` look "changed" to every effect that depends on it
  // (the auto-select-first-workbench effect below included), firing them on
  // every unrelated re-render rather than only when workbenches/chats data
  // itself moves.
  const state: WorkbenchesState = useMemo(() => {
    if (workbenches.isError) {
      return {
        kind: "error",
        message: describeChatError(
          workbenches.error,
          "Couldn't load workbenches.",
        ),
      };
    }
    if (chats.isError) {
      return {
        kind: "error",
        message: describeChatError(chats.error, "Couldn't load workbenches."),
      };
    }
    if (workbenches.data === undefined || chats.data === undefined) {
      return { kind: "loading" };
    }
    return { kind: "ready", workbenches: workbenches.data, chats: chats.data };
  }, [
    workbenches.isError,
    workbenches.error,
    workbenches.data,
    chats.isError,
    chats.error,
    chats.data,
  ]);

  return { state, reload };
}

function ChatWorkspaceInner({
  tenantId,
  workbenchId: controlledWorkbenchId,
  onWorkbenchChange,
  currentUser,
  onOpenProfile,
  settingsOpen = false,
  onSettingsOpenChange,
  settingsSection = "general",
  onSettingsSectionChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  headerLeading,
  registerComposerInsert,
  onOpenRoutines,
  listMembers,
  onCreateRoutineInSpace,
  onOpenInsights,
  presenceMembers,
  onWorkbenchNotFound,
  onBackToWorkbenchList,
  onSignIn,
}: {
  readonly tenantId: string;
  readonly workbenchId?: string | null;
  readonly onWorkbenchChange?: (workbenchId: string) => void;
  readonly currentUser?: CurrentUser;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed workbench's settings surface should replace the
   * conversation stage (mock § Workbench settings — a full surface, never a
   * dialog). Host-controlled the same way `workbenchId` is: driven from the
   * URL (`/c/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close. `section` is
   * only passed on open — the section the opener meant to land on (the
   * gear button's General, or the composer's `/agents` shortcut) — so the
   * host can navigate straight to that URL without a second, separate
   * navigation for the section. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: WorkbenchSettingsSectionId,
  ) => void;
  /** Which workbench settings tab is active while the surface is open —
   * host-controlled the same way `settingsOpen` is, driven from the URL
   * (`/c/:id/settings/:section`). */
  readonly settingsSection?: WorkbenchSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: WorkbenchSettingsSectionId,
  ) => void;
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** See `WorkbenchTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  readonly approvalActions?: ApprovalActions;
  readonly blockResponses?: BlockResponseActions;
  readonly headerLeading?: ReactNode;
  /**
   * Hands the host a function that inserts text into the active workbench's
   * composer, or `null` while no composer is mounted (loading/error states,
   * settings surface). The profile card's Mention action (CL-5914) is the
   * first caller — a shell-level seam, so the host stores the latest
   * function rather than this component reaching outside its own tree.
   */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /** The composer's `/run` command: routine create/run lives on its own
   * route the host owns, so opening it is a host-supplied hop the same way
   * `onOpenArtifact` is. */
  readonly onOpenRoutines?: () => void;
  /** Workspace members the mention popover's "Bring in…" group can
   * offer — the same reduced listing the shell already fetches for its
   * People views. Absent, the group only offers invitable agents. */
  readonly listMembers?: (
    tenantId: string,
  ) => Promise<readonly BringInMember[]>;

  /**
   * "New routine in this space" — the header button and the composer's
   * `/routine` command: opens the New Routine panel with the active
   * workbench pre-bound as its destination. Host-supplied so the panel's
   * own route (and its prefill store) stays owned by the host, the same
   * way `onOpenRoutines` is; the active workbench id is closed over here
   * rather than passed as an argument, since only this component knows
   * it. Omitted, the button and command are hidden — the same
   * "no dead promise" contract `onOpenRoutines` follows.
   */
  readonly onCreateRoutineInSpace?: (workbenchId: string) => void;
  /**
   * "Insights for this workbench" — the header button that deep-links to
   * this tenant's own Insights scope (CL-6099). Host-supplied so the
   * Insights route (and its tenant-scope resolution) stays owned by the
   * host, the same way `onOpenRoutines` is. Omitted, the button is
   * hidden — the same "no dead promise" contract as the other optional
   * header actions here.
   */
  readonly onOpenInsights?: () => void;
  /** See `ChatWorkspace`'s prop of the same name. */
  readonly presenceMembers?: readonly PresenceMember[];
  /** Fired when the routed workbench 404s — a deleted workbench, or a stale
   * Recents entry that outlived it. The host owns Recents (this package
   * never touches localStorage), so it's told rather than reaching out. */
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
  /** The dead-workbench empty state's way out — navigate to the bare workbench
   * list instead of retrying an id that can never resolve. */
  readonly onBackToWorkbenchList?: () => void;
  /** The 401 messages-error state's way out — sign back in instead of a
   * retry that can only ever hit the same 401. Omitted, that state falls
   * back to no action at all (never "Try again" for a session that's gone). */
  readonly onSignIn?: () => void;
}) {
  const queryClient = useQueryClient();
  const refreshWorkbenchLists = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workbenchesQueryKeyPrefix(tenantId),
    });
  }, [queryClient, tenantId]);
  const { state: workbenchesState, reload: reloadWorkbenches } =
    useWorkbenchLists(tenantId);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<string | null>(
    null,
  );
  const activeWorkbenchId = controlledWorkbenchId ?? selectedWorkbenchId;
  const setActiveWorkbenchId = (id: string) => {
    setSelectedWorkbenchId(id);
    onWorkbenchChange?.(id);
  };
  const [messagesState, setMessagesState] = useState<MessagesState>({
    kind: "loading",
  });
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  // null = workbench root feed. A concrete id opens that thread in the same
  // geometry (timeline + composer). pendingParentMessageId is set when the
  // user opens a reply on a message that has no thread yet.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pendingParentMessageId, setPendingParentMessageId] = useState<
    string | null
  >(null);
  const [threads, setThreads] = useState<readonly WorkbenchThread[]>([]);
  // Root-thread id from listThreads — used so the root feed loads
  // root-thread membership only, not the full workbench mailbox.
  const [rootThreadId, setRootThreadId] = useState<string | null>(null);
  // The workbench `rootThreadId` (state) was resolved for, mirrored in a ref.
  // `loadMessages` must never read the plain `rootThreadId` state directly:
  // React batches state updates, so a resolver that both writes the state
  // and immediately (same microtask, no render in between) triggers
  // `loadMessages` would still hand it last render's closed-over value —
  // one render stale, but on a workbench switch "one render stale" means
  // the *previous* workbench's thread id. A ref has no such lag; both halves
  // of this pair are only ever written together via `applyRootThread`
  // below, so a matching `workbenchId` guarantees a fresh `threadId`.
  const rootThreadRef = useRef<{
    readonly workbenchId: string;
    readonly threadId: string | null;
  } | null>(null);
  const applyRootThread = useCallback(
    (workbenchId: string, threadId: string | null) => {
      rootThreadRef.current = { workbenchId, threadId };
      setRootThreadId(threadId);
    },
    [],
  );
  const [threadMetaByMessageId, setThreadMetaByMessageId] = useState<
    ReadonlyMap<string, ThreadAffordanceMeta>
  >(new Map());
  // Absent (not `[]`) until the first successful `listPinnedMessages` —
  // `undefined` means "not wired or not loaded yet", so the pinned strip
  // renders nothing rather than a fabricated empty state on workbench
  // switch. A 404 (no `pins` store on the host) resolves to `[]` and
  // stays there — the strip is simply never shown for that deployment.
  const [pinnedMessages, setPinnedMessages] = useState<
    readonly PinnedMessage[]
  >([]);
  // This composer's own optimistic sends — see `mergePendingSends`. A
  // workbench switch drops whatever was pending in the previous workbench:
  // its composer submit targeted that workbench, not wherever the reader
  // navigated to next.
  const [pendingSends, setPendingSends] = useState<readonly PendingSend[]>([]);

  const unauthorizedRef = useRef(false);
  const composerRef = useRef<ComposerHandle>(null);
  // `loadMessages` calls overlap constantly — every SSE event fires a
  // background refresh, and a send fires its own on top — with no
  // guarantee the responses resolve in call order. Without a guard,
  // "last response to resolve wins" can let a stale fetch that started
  // before a newer one clobber it once it resolves later, flickering a
  // just-landed message back out (or a just-cleared pending bubble back
  // in). This ticket makes it "last request ISSUED wins" instead: each
  // call takes the next ticket, and only the call still holding the
  // latest ticket when it resolves is allowed to touch state.
  const messagesRequestSeqRef = useRef(0);

  const loadThreads = useCallback(
    async (workbenchId: string) => {
      try {
        const page = await listThreads(tenantId, workbenchId);
        setThreads(page.items);
        applyRootThread(
          workbenchId,
          page.rootThreadId !== "" ? page.rootThreadId : null,
        );
        // Build affordance meta for parent messages that already have a
        // reply thread. Reply counts load lazily when the thread is opened;
        // until then we surface "Thread" via replyCount 0+.
        const replyThreads = page.items.filter(
          (t) => t.kind === "reply" && t.parentMessageId !== null,
        );
        const meta = new Map<string, ThreadAffordanceMeta>();
        await Promise.all(
          replyThreads.map(async (thread) => {
            if (thread.parentMessageId === null) return;
            try {
              const detail = await listThreadMessages(
                tenantId,
                workbenchId,
                thread.id,
              );
              const items = detail.items;
              const addresses = [
                ...new Set(
                  items
                    .map((item) => item.sender?.address)
                    .filter((a): a is string => typeof a === "string"),
                ),
              ];
              const last = items.at(-1);
              meta.set(thread.parentMessageId, {
                replyCount: items.length,
                lastActivityAt: last?.createdAt ?? thread.createdAt,
                participantAddresses: addresses,
              });
            } catch {
              meta.set(thread.parentMessageId, {
                replyCount: 0,
                lastActivityAt: thread.createdAt,
                participantAddresses: [],
              });
            }
          }),
        );
        setThreadMetaByMessageId(meta);
      } catch {
        setThreads([]);
        applyRootThread(workbenchId, null);
        setThreadMetaByMessageId(new Map());
      }
    },
    [tenantId, applyRootThread],
  );

  const loadPins = useCallback(
    async (workbenchId: string) => {
      try {
        setPinnedMessages(await listPinnedMessages(tenantId, workbenchId));
      } catch {
        // No `pins` store on this host, or a transient read failure —
        // either way the strip just doesn't show, the same "absent
        // store, absent surface" contract the wire's own `pinned` field
        // follows server-side.
        setPinnedMessages([]);
      }
    },
    [tenantId],
  );

  // `background: true` is a refresh from SSE/polling: the previous ready
  // items stay on screen (and the composer stays mounted) until fresh data
  // lands, and a failed background refresh is swallowed rather than
  // replacing the timeline with an error page. Only a first load or a
  // workbench switch (background left false) shows the loading skeleton or
  // an error state.
  const loadMessages = useCallback(
    async (
      workbenchId: string,
      options?: { readonly background?: boolean },
    ) => {
      const background = options?.background ?? false;
      const ticket = ++messagesRequestSeqRef.current;
      if (!background) setMessagesState({ kind: "loading" });
      try {
        // Root feed may race with loadThreads on workbench switch: if we
        // don't yet know the root thread id, resolve it from listThreads
        // before loading messages so we never fall back to full mail while
        // threads are available. Read `rootThreadRef`, never the plain
        // `rootThreadId` state — a caller that both resolves the ref and
        // invokes `loadMessages` in the same tick (no render in between,
        // see `applyRootThread`'s doc) would otherwise still be handed
        // last render's closed-over state, which on a workbench switch is
        // the *previous* workbench's thread id.
        let resolvedRootThreadId =
          rootThreadRef.current?.workbenchId === workbenchId
            ? rootThreadRef.current.threadId
            : null;
        if (
          openThreadId === null &&
          pendingParentMessageId === null &&
          (resolvedRootThreadId === null || resolvedRootThreadId === "")
        ) {
          try {
            const threadsPage = await listThreads(tenantId, workbenchId);
            resolvedRootThreadId =
              threadsPage.rootThreadId !== "" ? threadsPage.rootThreadId : null;
            applyRootThread(workbenchId, resolvedRootThreadId);
            setThreads(threadsPage.items);
          } catch {
            resolvedRootThreadId = null;
          }
        }

        const target = resolveMessageFeedTarget({
          openThreadId,
          pendingParentMessageId,
          rootThreadId: resolvedRootThreadId,
        });

        // A thread hangs off a message the reader was just looking at —
        // rendering the thread without it strands the conversation
        // context. Prepend the parent from the workbench feed when the
        // thread's own page doesn't carry it; a parent that can't be
        // found (deleted, out of the fetched window) degrades to the
        // bare thread rather than an error.
        async function withParentContext(
          items: MessageItem[],
          parentMessageId: string | null,
        ): Promise<MessageItem[]> {
          if (
            parentMessageId === null ||
            items.some((m) => m.id === parentMessageId)
          ) {
            return items;
          }
          try {
            const workbenchPage = await listMessages(tenantId, workbenchId);
            const parent = workbenchPage.items.find(
              (m) => m.id === parentMessageId,
            );
            return parent === undefined ? items : [parent, ...items];
          } catch {
            return items;
          }
        }

        async function fetchTarget(
          fetchFor: MessageFeedTarget,
        ): Promise<MessageItem[]> {
          switch (fetchFor.kind) {
            case "thread": {
              const page = await listThreadMessages(
                tenantId,
                workbenchId,
                fetchFor.threadId,
              );
              return withParentContext(
                sortMessagesOldestFirst(page.items),
                page.thread.parentMessageId,
              );
            }
            case "empty":
              // Brand-new reply thread — no replies yet, but the message
              // it is being started from is the context the composer
              // needs on screen.
              return withParentContext([], pendingParentMessageId);
            case "root-thread": {
              const page = await listThreadMessages(
                tenantId,
                workbenchId,
                fetchFor.rootThreadId,
              );
              // Membership order is assignment order; timeline wants
              // oldest-first with the viewport pinned to the end.
              return sortMessagesOldestFirst(page.items);
            }
            case "workbench-mail": {
              // Threads not available on this hub — full mailbox is the
              // only feed source (and there is no reply-thread
              // membership to mix in).
              const page = await listMessages(tenantId, workbenchId);
              return sortMessagesOldestFirst(page.items);
            }
          }
        }

        let items: MessageItem[];
        try {
          items = await fetchTarget(target);
        } catch (cause) {
          // A remembered thread id can outlive the server-side run it
          // named — e.g. across a hub restart (CL-6067), where the
          // reconnect-ownership challenge treats the run as dead and
          // every id under it 404s from here on. That is a stale
          // reference, not a real failure: discard it and fall back to
          // the workbench's live feed instead of a dead-end error a "Try
          // again" can never actually recover from.
          const isStaleThreadRef =
            cause instanceof ChatApiError &&
            cause.status === 404 &&
            (target.kind === "thread" || target.kind === "root-thread");
          if (!isStaleThreadRef) throw cause;
          if (target.kind === "thread") setOpenThreadId(null);
          if (target.kind === "root-thread") applyRootThread(workbenchId, null);
          const fallbackTarget = resolveMessageFeedTarget({
            openThreadId: target.kind === "thread" ? null : openThreadId,
            pendingParentMessageId,
            rootThreadId:
              target.kind === "root-thread" ? null : resolvedRootThreadId,
          });
          items = await fetchTarget(fallbackTarget);
        }
        // A newer `loadMessages` call has been issued since this one
        // started — its own result (whenever it resolves) is the one
        // that gets to land; this response is stale by definition and
        // applying it now would only flicker the timeline backward.
        if (ticket !== messagesRequestSeqRef.current) return;
        setMessagesState((current) =>
          nextMessagesState(current, { kind: "success", items }, background),
        );
        if (openThreadId === null && pendingParentMessageId === null) {
          const last = items.at(-1);
          if (last !== undefined) {
            await putReadState(tenantId, workbenchId, {
              lastSeenCreatedAt: last.createdAt,
              lastSeenId: last.id,
            }).catch(() => undefined);
          }
        }
      } catch (cause) {
        if (ticket !== messagesRequestSeqRef.current) return;
        // A 401 is terminal for this session: keep polling and the app
        // would hammer the hub unauthenticated forever. Halt refreshes
        // until the user switches workbenches or signs back in.
        const isUnauthorized =
          cause instanceof UnauthenticatedError ||
          (cause instanceof ChatApiError && cause.status === 401);
        if (isUnauthorized) {
          unauthorizedRef.current = true;
        }
        // A 404 here means the workbench itself is gone (deleted, or a stale
        // id from a Recents entry that outlived it) — not a transient load
        // failure a retry could fix. Tell the host so it can drop the dead
        // Recents entry the same way it dropped the dead thread ref above.
        const workbenchNotFound =
          cause instanceof ChatApiError && cause.status === 404;
        if (workbenchNotFound) onWorkbenchNotFound?.(workbenchId);
        const message = describeChatError(cause, "Couldn't load messages.");
        setMessagesState((current) =>
          nextMessagesState(
            current,
            { kind: "error", message, workbenchNotFound, isUnauthorized },
            background,
          ),
        );
      }
    },
    [
      tenantId,
      openThreadId,
      pendingParentMessageId,
      applyRootThread,
      onWorkbenchNotFound,
    ],
  );

  // Picking a default workbench is this component's own fallback for "no
  // workbench named in the URL yet".
  useEffect(() => {
    if (workbenchesState.kind !== "ready") return;
    if (activeWorkbenchId !== null) return;
    const first = workbenchesState.workbenches[0] ?? workbenchesState.chats[0];
    if (first !== undefined) setActiveWorkbenchId(first.id);
  }, [workbenchesState, activeWorkbenchId]);

  useEffect(() => {
    unauthorizedRef.current = false;
    setOpenThreadId(null);
    setPendingParentMessageId(null);
    setRootThreadId(null);
    setPendingSends([]);
    if (activeWorkbenchId !== null) {
      void loadThreads(activeWorkbenchId);
      void loadMessages(activeWorkbenchId);
      void loadPins(activeWorkbenchId);
    }
  }, [activeWorkbenchId]); // eslint-disable-line react-hooks/exhaustive-deps -- workbench switch resets thread view

  useEffect(() => {
    if (activeWorkbenchId === null) return;
    void loadMessages(activeWorkbenchId);
  }, [openThreadId, pendingParentMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshUnlessUnauthorized = () => {
    if (unauthorizedRef.current) return;
    if (activeWorkbenchId !== null) {
      void loadMessages(activeWorkbenchId, { background: true });
      void loadThreads(activeWorkbenchId);
    }
  };

  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      if (activeWorkbenchId === null) return;
      toggleReaction(tenantId, activeWorkbenchId, messageId, emoji)
        .then(() => loadMessages(activeWorkbenchId, { background: true }))
        .catch(() => toast(CHAT_STRINGS.reactionToggleError));
    },
    [tenantId, activeWorkbenchId, loadMessages],
  );

  const handlePinMessage = useCallback(
    (messageId: string) => {
      if (activeWorkbenchId === null) return;
      pinMessage(tenantId, activeWorkbenchId, messageId)
        .then(() =>
          Promise.all([
            loadMessages(activeWorkbenchId, { background: true }),
            loadPins(activeWorkbenchId),
          ]),
        )
        .catch(() => toast(CHAT_STRINGS.pinMessageError));
    },
    [tenantId, activeWorkbenchId, loadMessages, loadPins],
  );

  const handleUnpinMessage = useCallback(
    (messageId: string) => {
      if (activeWorkbenchId === null) return;
      unpinMessage(tenantId, activeWorkbenchId, messageId)
        .then(() =>
          Promise.all([
            loadMessages(activeWorkbenchId, { background: true }),
            loadPins(activeWorkbenchId),
          ]),
        )
        .catch(() => toast(CHAT_STRINGS.unpinMessageError));
    },
    [tenantId, activeWorkbenchId, loadMessages, loadPins],
  );

  const reactionActions: ReactionActions = useMemo(
    () => ({ onToggle: handleToggleReaction }),
    [handleToggleReaction],
  );
  const pinActions: PinActions = useMemo(
    () => ({ onPin: handlePinMessage, onUnpin: handleUnpinMessage }),
    [handlePinMessage, handleUnpinMessage],
  );

  function jumpToMessage(messageId: string) {
    document
      .getElementById(messageDomId(messageId))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const composerMounted =
    !settingsOpen &&
    activeWorkbenchId !== null &&
    messagesState.kind === "ready";

  useEffect(() => {
    if (registerComposerInsert === undefined) return;
    if (!composerMounted) {
      registerComposerInsert(null);
      return;
    }
    registerComposerInsert((text) => composerRef.current?.insertText(text));
    return () => registerComposerInsert(null);
  }, [registerComposerInsert, composerMounted]);

  const { typingState, handleStreamEvent: handleTypingEvent } =
    useTypingIndicator(currentUser?.principalId, activeWorkbenchId);
  const {
    streamingReply,
    replyTimedOut,
    handleStreamEvent: handleStreamingReplyEvent,
    noteAwaitingReply,
  } = useStreamingReply(activeWorkbenchId);
  const { activity: turnActivity, handleStreamEvent: handleTurnActivityEvent } =
    useTurnActivity(activeWorkbenchId);

  // Opening Settings swaps `WorkbenchTimeline` out for `WorkbenchSettingsSurface`
  // entirely (see the early `settingsOpen` return below) — closing it
  // remounts a fresh `WorkbenchTimeline` with no memory of where the reader
  // was. A ref (not state) holds each workbench's last snapshot: recording it
  // never needs to trigger a re-render, only be there the next time this
  // workbench's `WorkbenchTimeline` mounts.
  const scrollSnapshotsRef = useRef<ReadonlyMap<string, ScrollSnapshot>>(
    new Map(),
  );
  const restoredScrollSnapshot =
    activeWorkbenchId !== null
      ? scrollSnapshotsRef.current.get(activeWorkbenchId)
      : undefined;
  const handleScrollSnapshot = useCallback(
    (snapshot: ScrollSnapshot) => {
      if (activeWorkbenchId === null) return;
      scrollSnapshotsRef.current = withScrollSnapshot(
        scrollSnapshotsRef.current,
        activeWorkbenchId,
        snapshot,
      );
    },
    [activeWorkbenchId],
  );

  useWorkbenchStream(
    activeWorkbenchId !== null
      ? workbenchStreamUrl(tenantId, activeWorkbenchId)
      : "",
    (eventType, data) => {
      handleTypingEvent(eventType, data);
      handleStreamingReplyEvent(eventType, data);
      handleTurnActivityEvent(eventType, data);
      if (eventType !== "chat.typing") refreshUnlessUnauthorized();
      if (eventType === "chat.pin" && activeWorkbenchId !== null) {
        void loadPins(activeWorkbenchId);
      }
    },
    refreshUnlessUnauthorized,
  );

  /** The one door into the workbench settings surface — the gear button and
   * the composer's `/agents` command both go through this so the section
   * that lands is always the one the caller meant to open. */
  function openWorkbenchSettings(
    section: WorkbenchSettingsSectionId = "general",
  ) {
    onSettingsOpenChange?.(true, section);
  }

  async function handleInvite(definitionId: string) {
    if (activeWorkbenchId === null) return;
    await inviteAgent(tenantId, activeWorkbenchId, definitionId);
    // The invited agent's address lands on the workbench's participants
    // (the mention popover picks it up via the reload below) and its
    // join event lands on the timeline.
    refreshWorkbenchLists();
    await loadMessages(activeWorkbenchId);
  }

  /**
   * The optimistic core both a fresh composer submit and a bubble's own
   * Retry button drive: adds (or resets) a pending entry before the
   * request goes out, so the sender sees their message land in the
   * timeline immediately rather than waiting on the round-trip. Once the
   * POST resolves, the confirmed item (built straight from its response —
   * no extra round-trip) replaces the pending entry in the very same
   * state update: there is never a render where the message has vanished
   * from both `pendingSends` and `messagesState.items` while a fresh
   * `GET` is still in flight to reintroduce it, and never a render where
   * both the pending and confirmed copies show at once. The follow-up
   * background `loadMessages` still runs to pick up server-only detail
   * (real sender record, reactions, thread meta) — it settles into that
   * data under the same `clientId` key, so it never re-triggers the
   * mount/unmount swap this replaces. A rejected send flips the pending
   * entry to `"failed"` in place instead — never a status line
   * disconnected from the message it describes.
   */
  async function sendPending(
    nonce: string,
    text: string,
    attachments: readonly ComposerAttachment[],
    invite?: readonly MentionInviteIntent[],
  ): Promise<void> {
    if (activeWorkbenchId === null) return;
    const parts = partsForSend(text, attachments);
    if (parts.length === 0) return;
    const inviteOption = invite !== undefined ? { invite } : {};
    // The pending bubble's own nonce doubles as its wire `clientId` —
    // no second id needed. The server echoes it back below and, once
    // wired, records it against the message so the next `GET
    // .../messages` page carries it too; `mergePendingSends` drops
    // this pending entry the moment either arrival shows up with a
    // matching `clientId`, so whichever wins this race, the other is
    // a no-op.
    try {
      let sent: {
        readonly id: string;
        readonly createdAt: string;
        readonly threadId?: string;
        readonly clientId?: string;
      };
      if (openThreadId !== null) {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          threadId: openThreadId,
          clientId: nonce,
          ...inviteOption,
        });
      } else if (pendingParentMessageId !== null) {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          inReplyToMessageId: pendingParentMessageId,
          clientId: nonce,
          ...inviteOption,
        });
        if (sent.threadId !== undefined) {
          setOpenThreadId(sent.threadId);
          setPendingParentMessageId(null);
        }
      } else {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          clientId: nonce,
          ...inviteOption,
        });
      }
      const confirmed: MessageItem = {
        id: sent.id,
        createdAt: sent.createdAt,
        parts,
        sender: {
          name: null,
          address: pendingSenderAddress(currentUser?.principalId),
        },
        clientId: sent.clientId ?? nonce,
      };
      // A background refresh may have already folded the confirmed
      // message into `items` (refresh-first interleaving) — appending
      // unconditionally would render it twice under one key.
      setMessagesState((current) => {
        if (current.kind !== "ready") return current;
        const alreadyPresent = current.items.some(
          (item) =>
            item.id === confirmed.id || item.clientId === confirmed.clientId,
        );
        if (alreadyPresent) return current;
        return { kind: "ready", items: [...current.items, confirmed] };
      });
      setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
      // A message just landed in a workbench with an agent in it: a reply
      // is owed, so show the typing indicator now rather than sitting
      // silent until the turn's first stream event arrives.
      if (
        (activeWorkbench?.participants ?? []).some((participant) =>
          isAgentAddress(participant.address),
        )
      ) {
        noteAwaitingReply();
      }
      await loadThreads(activeWorkbenchId);
      await loadMessages(activeWorkbenchId, { background: true });
    } catch (cause) {
      if (cause instanceof ChatApiError && cause.status === 403) {
        toast(CHAT_STRINGS.mentionForbidden);
      }
      setPendingSends((current) =>
        current.map((p) =>
          p.nonce === nonce ? { ...p, status: "failed" } : p,
        ),
      );
    }
  }

  async function handleSend(payload: ComposerSendPayload): Promise<boolean> {
    if (activeWorkbenchId === null) return false;
    const parts = partsForSend(payload.text, payload.attachments);
    if (parts.length === 0) return false;
    const nonce = nextPendingSendNonce();
    setPendingSends((current) => [
      ...current,
      {
        nonce,
        text: payload.text,
        attachments: payload.attachments,
        createdAt: new Date().toISOString(),
        status: "sending",
        ...(payload.invite !== undefined ? { invite: payload.invite } : {}),
      },
    ]);
    await sendPending(nonce, payload.text, payload.attachments, payload.invite);
    return true;
  }

  function retryPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) =>
      current.map((p) => (p.nonce === nonce ? { ...p, status: "sending" } : p)),
    );
    void sendPending(nonce, pending.text, pending.attachments, pending.invite);
  }

  /** Drops the failed pending bubble and hands its text back to the
   * composer's draft — the only door recovered text comes back through,
   * since a submit always clears the box on the way out. */
  function discardPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
    if (pending.text.length > 0) {
      composerRef.current?.insertText(pending.text);
    }
  }

  function openThreadForMessage(messageId: string) {
    const existing = threads.find(
      (t) => t.kind === "reply" && t.parentMessageId === messageId,
    );
    if (existing !== undefined) {
      setPendingParentMessageId(null);
      setOpenThreadId(existing.id);
      return;
    }
    setOpenThreadId(null);
    setPendingParentMessageId(messageId);
  }

  /**
   * The fork affordance (CL-5948): any message inside an open thread can
   * spawn a sub-thread rooted at it. Unlike the lazy root-feed reply
   * above, a fork is created eagerly — the server resolves depth (a new
   * depth-2 sub-thread, or a depth-cap-redirected sibling if the origin
   * message is already inside one) so this UI never has to reason about
   * nesting itself.
   */
  async function forkMessage(messageId: string) {
    if (activeWorkbenchId === null) return;
    const existing = threads.find(
      (t) => t.kind === "reply" && t.parentMessageId === messageId,
    );
    if (existing !== undefined) {
      setPendingParentMessageId(null);
      setOpenThreadId(existing.id);
      return;
    }
    try {
      const forked = await forkThread(tenantId, activeWorkbenchId, messageId);
      await loadThreads(activeWorkbenchId);
      setPendingParentMessageId(null);
      setOpenThreadId(forked.id);
    } catch {
      toast(CHAT_STRINGS.forkThreadError);
    }
  }

  function closeThread() {
    setOpenThreadId(null);
    setPendingParentMessageId(null);
  }

  const activeWorkbench =
    workbenchesState.kind === "ready"
      ? [...workbenchesState.workbenches, ...workbenchesState.chats].find(
          (workbench) => workbench.id === activeWorkbenchId,
        )
      : undefined;
  const isActiveChat =
    activeWorkbench !== undefined &&
    isKnownWorkbenchKind(activeWorkbench.kind) &&
    activeWorkbench.kind === "chat";
  const activeChatAgent = isActiveChat
    ? activeWorkbench?.participants.find((participant) =>
        isAgentAddress(participant.address),
      )
    : undefined;

  // The mention popover's "Bring in…" group: only a `workbench` grows its
  // participants after creation (a chat's counterpart is fixed at
  // creation — see `workbench-service.ts`'s `joinHumanParticipant`/
  // `launchAndJoinAgent` doc comments), so these only fetch for that
  // kind, and never before a workbench is actually selected.
  const bringInEnabled =
    activeWorkbenchId !== null &&
    activeWorkbench !== undefined &&
    isKnownWorkbenchKind(activeWorkbench.kind) &&
    activeWorkbench.kind === "workbench";
  const invitableAgentsQuery = useQuery({
    queryKey: ["tenant", tenantId, "chat", "invitable", activeWorkbenchId],
    queryFn: () =>
      activeWorkbenchId !== null
        ? listInvitableDefinitions(tenantId, activeWorkbenchId)
        : Promise.resolve([]),
    enabled: bringInEnabled,
  });
  const bringInMembersQuery = useQuery({
    queryKey: ["tenant", tenantId, "chat", "bring-in-members"],
    queryFn: () =>
      listMembers !== undefined ? listMembers(tenantId) : Promise.resolve([]),
    enabled: bringInEnabled && listMembers !== undefined,
  });

  // A settings URL for a workbench id that resolved workbenches don't contain
  // (deleted, mistyped, cross-tenant) would otherwise leave the surface
  // silently showing the ordinary chat view under a lying /settings URL —
  // correct the route instead of no-opping.
  useEffect(() => {
    if (!settingsOpen) return;
    if (workbenchesState.kind !== "ready") return;
    if (activeWorkbenchId === null) return;
    if (activeWorkbench !== undefined) return;
    onSettingsOpenChange?.(false);
  }, [
    settingsOpen,
    workbenchesState.kind,
    activeWorkbenchId,
    activeWorkbench,
    onSettingsOpenChange,
  ]);

  const replyThreads = useMemo(
    () => threads.filter((t) => t.kind === "reply"),
    [threads],
  );
  // Two levels, stop: a depth-1 thread hangs off the root; a depth-2
  // sub-thread hangs off a depth-1 thread (CL-5908). Grouping threads
  // menu items and the breadcrumb both key off this same split.
  const depth1Threads = useMemo(
    () => replyThreads.filter((t) => t.parentThreadId === rootThreadId),
    [replyThreads, rootThreadId],
  );
  const subThreadsByParentId = useMemo(() => {
    const map = new Map<string, WorkbenchThread[]>();
    for (const t of replyThreads) {
      if (t.parentThreadId === null || t.parentThreadId === rootThreadId) {
        continue;
      }
      const list = map.get(t.parentThreadId) ?? [];
      map.set(t.parentThreadId, [...list, t]);
    }
    return map;
  }, [replyThreads, rootThreadId]);
  const openThread =
    openThreadId === null
      ? undefined
      : threads.find((t) => t.id === openThreadId);
  // A sub-thread's breadcrumb parent segment — undefined for a depth-1
  // thread (or no thread open at all), which breadcrumbs straight back to
  // the workbench.
  const openThreadParent =
    openThread?.parentThreadId !== undefined &&
    openThread.parentThreadId !== null &&
    openThread.parentThreadId !== rootThreadId
      ? threads.find((t) => t.id === openThread.parentThreadId)
      : undefined;
  const inThreadView = openThreadId !== null || pendingParentMessageId !== null;
  const threadTitle =
    openThread?.title ??
    (pendingParentMessageId !== null ? "New thread" : "Thread");
  // Team stack: every active agent + live human for the top bar.
  const teamStack = buildTeamAvatarStack(
    activeWorkbench?.participants ?? [],
    presenceMembers ?? [],
  );
  const visibleTeamStack = teamStack.slice(0, TEAM_AVATAR_STACK_LIMIT);
  const teamStackOverflow = teamStack.length - visibleTeamStack.length;

  // The workbench header only exists once a workbench is active; the loading,
  // error, and no-workbench states still carry the host's leading control (the
  // shell's col2 toggle) so the sidebar stays reachable.
  const bareLeadingHeader =
    headerLeading !== undefined &&
    (workbenchesState.kind !== "ready" || activeWorkbenchId === null) ? (
      <div className="chat-workbench-header">{headerLeading}</div>
    ) : null;

  if (
    settingsOpen &&
    activeWorkbenchId !== null &&
    activeWorkbench !== undefined
  ) {
    return (
      <>
        <div className="chat-workspace">
          <WorkbenchSettingsSurface
            key={activeWorkbenchId}
            tenantId={tenantId}
            workbenchId={activeWorkbenchId}
            workbenchTitle={
              activeWorkbench.title || CHAT_STRINGS.unnamedWorkbench
            }
            section={settingsSection}
            onSectionChange={(next) => onSettingsSectionChange?.(next)}
            onBack={() => onSettingsOpenChange?.(false)}
            onInviteParticipant={() => {
              onSettingsOpenChange?.(false);
              setInviteDialogOpen(true);
            }}
            onSaved={refreshWorkbenchLists}
            {...(currentUser !== undefined
              ? { currentUserPrincipalId: currentUser.principalId }
              : {})}
          />
        </div>
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          workbenchId={activeWorkbenchId}
          onInvite={handleInvite}
        />
      </>
    );
  }

  return (
    <>
      <div className="chat-workspace">
        <div className="chat-main">
          {bareLeadingHeader}
          {workbenchesState.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : workbenchesState.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={`Couldn't load ${CHAT_STRINGS.couldNotLoadWorkbenches}`}
              description={workbenchesState.message}
              action={
                <Button
                  variant="outline"
                  onClick={() => void reloadWorkbenches()}
                >
                  Try again
                </Button>
              }
            />
          ) : activeWorkbenchId === null ? (
            <EmptyState
              icon={<MessageSquare />}
              title={CHAT_STRINGS.noChatSelectedTitle}
              description={CHAT_STRINGS.noChatSelectedDescription}
            />
          ) : (
            <>
              <div className="chat-workbench-header">
                {headerLeading}
                {inThreadView ? (
                  <nav className="chat-thread-breadcrumb" aria-label="Thread">
                    <button
                      type="button"
                      className="chat-thread-breadcrumb-link"
                      onClick={closeThread}
                    >
                      {activeWorkbench?.title || CHAT_STRINGS.unnamedWorkbench}
                    </button>
                    <span
                      className="chat-thread-breadcrumb-sep"
                      aria-hidden="true"
                    >
                      /
                    </span>
                    {openThreadParent !== undefined ? (
                      <>
                        <button
                          type="button"
                          className="chat-thread-breadcrumb-link"
                          onClick={() => {
                            setPendingParentMessageId(null);
                            setOpenThreadId(openThreadParent.id);
                          }}
                        >
                          {openThreadParent.title ?? "Thread"}
                        </button>
                        <span
                          className="chat-thread-breadcrumb-sep"
                          aria-hidden="true"
                        >
                          /
                        </span>
                      </>
                    ) : null}
                    <span
                      className="chat-thread-breadcrumb-current"
                      aria-current="page"
                    >
                      {threadTitle}
                    </span>
                  </nav>
                ) : (
                  <div className="chat-workbench-identity">
                    <h2 className="chat-workbench-title">
                      {activeWorkbench?.title || CHAT_STRINGS.unnamedWorkbench}
                    </h2>
                    {activeChatAgent !== undefined ? <AgentBadge /> : null}
                  </div>
                )}
                <div className="chat-workbench-actions">
                  {depth1Threads.length > 0 ? (
                    <details className="chat-threads-menu">
                      <summary className="chat-threads-menu-trigger">
                        {CHAT_STRINGS.threadsMenuCount(depth1Threads.length)}
                        <ChevronDown className="size-3.5 opacity-70" />
                      </summary>
                      <div className="chat-threads-menu-panel" role="menu">
                        {depth1Threads.map((thread) => (
                          <div
                            key={thread.id}
                            className="chat-threads-menu-group"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="chat-threads-menu-item"
                              onClick={() => {
                                setPendingParentMessageId(null);
                                setOpenThreadId(thread.id);
                              }}
                            >
                              {thread.title ??
                                (thread.parentMessageId !== null
                                  ? `Reply · ${thread.parentMessageId.slice(0, 8)}`
                                  : "Thread")}
                            </button>
                            {(subThreadsByParentId.get(thread.id) ?? []).map(
                              (subThread) => (
                                <button
                                  key={subThread.id}
                                  type="button"
                                  role="menuitem"
                                  className="chat-threads-menu-item chat-threads-menu-item-nested"
                                  onClick={() => {
                                    setPendingParentMessageId(null);
                                    setOpenThreadId(subThread.id);
                                  }}
                                >
                                  {subThread.title ??
                                    (subThread.parentMessageId !== null
                                      ? `Fork · ${subThread.parentMessageId.slice(0, 8)}`
                                      : "Sub-thread")}
                                </button>
                              ),
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {visibleTeamStack.length > 0 ? (
                    <div
                      className="chat-team-stack"
                      aria-label={CHAT_STRINGS.workbenchMembersLabel}
                    >
                      {visibleTeamStack.map((entry) =>
                        entry.tone === "agent" ? (
                          <span
                            key={entry.key}
                            className="chat-presence-avatar"
                            data-agent="true"
                            title={entry.label}
                          >
                            {entry.initials.slice(0, 1).toUpperCase()}
                          </span>
                        ) : (
                          <span
                            key={entry.key}
                            className="chat-presence-avatar"
                            style={{ backgroundColor: entry.color }}
                            title={entry.label}
                          >
                            {entry.initials}
                          </span>
                        ),
                      )}
                      {teamStackOverflow > 0 ? (
                        <span
                          className="chat-team-stack-overflow"
                          title={CHAT_STRINGS.teamStackOverflow(
                            teamStackOverflow,
                          )}
                        >
                          +{teamStackOverflow}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {canInviteAgent(activeWorkbench?.kind) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInviteDialogOpen(true)}
                    >
                      <UserPlus />
                      {CHAT_STRINGS.inviteAgentAction}
                    </Button>
                  ) : null}
                  {onOpenRoutines !== undefined ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={CHAT_STRINGS.routinesAction}
                      title={CHAT_STRINGS.routinesAction}
                      onClick={() => onOpenRoutines()}
                    >
                      <Repeat />
                    </Button>
                  ) : null}
                  {onOpenInsights !== undefined ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpenInsights()}
                    >
                      <ChartColumn />
                      {CHAT_STRINGS.insightsAction}
                    </Button>
                  ) : null}
                  <div className="chat-workbench-settings-slot">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={CHAT_STRINGS.workbenchSettingsAction}
                      title={CHAT_STRINGS.workbenchSettingsAction}
                      onClick={() => openWorkbenchSettings()}
                    >
                      <SlidersHorizontal />
                    </Button>
                  </div>
                </div>
              </div>
              {messagesState.kind === "loading" ? (
                <Skeleton className="query-skeleton" />
              ) : messagesState.kind === "error" &&
                messagesState.workbenchNotFound ? (
                <EmptyState
                  icon={<CircleAlert />}
                  title={CHAT_STRINGS.workbenchNotFoundTitle}
                  description={CHAT_STRINGS.workbenchNotFoundDescription}
                  action={
                    onBackToWorkbenchList !== undefined ? (
                      <Button variant="outline" onClick={onBackToWorkbenchList}>
                        {CHAT_STRINGS.workbenchNotFoundAction}
                      </Button>
                    ) : undefined
                  }
                />
              ) : messagesState.kind === "error" ? (
                <EmptyState
                  icon={<CircleAlert />}
                  title={`Couldn't load ${CHAT_STRINGS.couldNotLoadMessages}`}
                  description={messagesState.message}
                  action={
                    messagesState.isUnauthorized ? (
                      onSignIn !== undefined ? (
                        <Button variant="outline" onClick={onSignIn}>
                          Sign in
                        </Button>
                      ) : undefined
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => void loadMessages(activeWorkbenchId)}
                      >
                        Try again
                      </Button>
                    )
                  }
                />
              ) : (
                <>
                  {!inThreadView ? (
                    <PinnedStrip
                      items={pinnedMessages}
                      onJump={jumpToMessage}
                    />
                  ) : null}
                  {openThreadParent !== undefined ? (
                    <div className="chat-thread-origin-banner">
                      {CHAT_STRINGS.forkThreadOriginBanner}{" "}
                      <button
                        type="button"
                        className="chat-thread-origin-banner-link"
                        onClick={() => {
                          setPendingParentMessageId(null);
                          setOpenThreadId(openThreadParent.id);
                        }}
                      >
                        {openThreadParent.title ?? "Thread"}
                      </button>
                    </div>
                  ) : null}
                  <WorkbenchTimeline
                    settingUpAgent={
                      activeWorkbench?.kind === "chat" &&
                      typeof activeWorkbench.definitionId === "string"
                    }
                    launchPending={activeWorkbench?.launchPending === true}
                    items={appendReplyTimedOutNotice(
                      mergeStreamingReply(
                        mergePendingSends(
                          messagesState.items,
                          pendingSends,
                          currentUser?.principalId,
                        ),
                        streamingReply,
                        activeWorkbench?.participants ?? [],
                      ),
                      replyTimedOut,
                    )}
                    participants={activeWorkbench?.participants ?? []}
                    {...(currentUser !== undefined ? { currentUser } : {})}
                    threadMetaByMessageId={threadMetaByMessageId}
                    threadAffordanceMode={inThreadView ? "fork" : "reply"}
                    onOpenThread={
                      inThreadView ? forkMessage : openThreadForMessage
                    }
                    {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
                    {...(onOpenArtifact !== undefined
                      ? { onOpenArtifact }
                      : {})}
                    {...(onOpenArtifactInLibrary !== undefined
                      ? { onOpenArtifactInLibrary }
                      : {})}
                    {...(onFixConnection !== undefined
                      ? { onFixConnection }
                      : {})}
                    {...(approvalActions !== undefined
                      ? { approvalActions }
                      : {})}
                    {...(blockResponses !== undefined
                      ? { blockResponses }
                      : {})}
                    reactionActions={reactionActions}
                    pinActions={pinActions}
                    pendingActions={{
                      onRetry: retryPendingSend,
                      onDiscard: discardPendingSend,
                    }}
                    {...(restoredScrollSnapshot !== undefined
                      ? { scrollRestore: restoredScrollSnapshot }
                      : {})}
                    onScrollSnapshot={handleScrollSnapshot}
                  />
                  <TurnActivityStrip activity={turnActivity} />
                  {typingState !== null ? (
                    <TypingIndicator
                      label={typingLabel(
                        typingState.principalId,
                        activeWorkbench?.participants ?? [],
                      )}
                    />
                  ) : (
                    <AgentTypingIndicator
                      names={typingAgentNames(
                        streamingReply,
                        activeWorkbench?.participants ?? [],
                      )}
                    />
                  )}
                  <Composer
                    ref={composerRef}
                    agents={mentionCandidatesFromParticipants(
                      activeWorkbench?.participants ?? [],
                    )}
                    participants={activeWorkbench?.participants ?? []}
                    members={bringInMembersQuery.data ?? []}
                    invitableAgents={invitableAgentsQuery.data ?? []}
                    placeholder={composerPlaceholderFor(activeWorkbench)}
                    onSend={handleSend}
                    onInviteAgent={() => setInviteDialogOpen(true)}
                    onOpenAgentsSettings={() => openWorkbenchSettings("agents")}
                    onOpenRoutines={() => {
                      if (onOpenRoutines !== undefined) {
                        onOpenRoutines();
                        return;
                      }
                      toast(CHAT_STRINGS.runRoutineUnavailable);
                    }}
                    onCreateRoutineInSpace={() => {
                      if (
                        onCreateRoutineInSpace !== undefined &&
                        activeWorkbenchId !== null
                      ) {
                        onCreateRoutineInSpace(activeWorkbenchId);
                        return;
                      }
                      toast(CHAT_STRINGS.runRoutineUnavailable);
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
      {activeWorkbenchId !== null ? (
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          workbenchId={activeWorkbenchId}
          onInvite={handleInvite}
        />
      ) : null}
    </>
  );
}

function ChatWorkspaceFrame({ children }: { readonly children: ReactNode }) {
  return <div className="chat-workspace-frame">{children}</div>;
}

export function ChatWorkspace({
  tenant,
  workbenchId = null,
  onWorkbenchChange,
  currentUser,
  onOpenProfile,
  settingsOpen,
  onSettingsOpenChange,
  settingsSection,
  onSettingsSectionChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  headerLeading,
  registerComposerInsert,
  onOpenRoutines,
  listMembers,
  onCreateRoutineInSpace,
  onOpenInsights,
  presenceMembers,
  onWorkbenchNotFound,
  onBackToWorkbenchList,
  onSignIn,
}: {
  readonly tenant: TenantResolution;
  /** Controlled active workbench (e.g. from the app's URL); null = pick the first. */
  readonly workbenchId?: string | null;
  /** Fired when the user selects a workbench, so the app can reflect it in the URL. */
  readonly onWorkbenchChange?: (workbenchId: string) => void;
  /**
   * The signed-in account, so its own messages render as "You" (or its
   * name) instead of matching no participant and falling back to
   * "Member". Host-supplied, the same way `tenant` is — this package
   * never resolves a session itself.
   */
  readonly currentUser?: CurrentUser;
  /** Open a member/agent ProfileCard in the host canvas (shell mock § Profile). */
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed workbench's settings surface should replace the
   * conversation stage — host-controlled from the URL (`/c/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close, so the host can
   * reflect it in the URL — see `ChatWorkspaceInner`'s prop of the same
   * name for the `section` argument's contract. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: WorkbenchSettingsSectionId,
  ) => void;
  /** Which workbench settings tab is active — host-controlled from the URL
   * (`/c/:id/settings/:section`). */
  readonly settingsSection?: WorkbenchSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: WorkbenchSettingsSectionId,
  ) => void;
  /** Open a message's artifact chip — see `WorkbenchTimeline`'s `onOpenArtifact`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — see `WorkbenchTimeline`'s
   * `onOpenArtifactInLibrary`. */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's "Fix this connection"
   * action — see `WorkbenchTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — see `WorkbenchTimeline`'s
   * `approvalActions`. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — see `WorkbenchTimeline`'s
   * `blockResponses`. */
  readonly blockResponses?: BlockResponseActions;
  /** Host-supplied control rendered first in the workbench header — the
   * shell's single col2 toggle, so chat carries the same top-bar chrome as
   * every other stage surface. */
  readonly headerLeading?: ReactNode;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /** The composer's `/run` command — see `ChatWorkspaceInner`'s prop note. */
  readonly onOpenRoutines?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly listMembers?: (
    tenantId: string,
  ) => Promise<readonly BringInMember[]>;
  /** "New routine in this space" — see `ChatWorkspaceInner`'s prop note. */
  readonly onCreateRoutineInSpace?: (workbenchId: string) => void;
  /**
   * "Insights for this workbench" — the header button that deep-links to
   * this tenant's own Insights scope (CL-6099). Host-supplied so the
   * Insights route (and its tenant-scope resolution) stays owned by the
   * host, the same way `onOpenRoutines` is. Omitted, the button is
   * hidden — the same "no dead promise" contract as the other optional
   * header actions here.
   */
  readonly onOpenInsights?: () => void;
  /**
   * Who's live in the active workbench right now, beyond the static
   * participants list — the host's `@corbits/presence/client` connection,
   * handed down as data. Omitted entirely, no presence stack renders (the
   * header looks exactly as it did before presence existed).
   */
  readonly presenceMembers?: readonly PresenceMember[];
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onBackToWorkbenchList?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onSignIn?: () => void;
}) {
  switch (tenant.kind) {
    case "ready":
      // Remount on tenant switch so prior-tenant state cannot leak.
      return (
        <ChatWorkspaceInner
          key={tenant.tenantId}
          tenantId={tenant.tenantId}
          workbenchId={workbenchId}
          {...(onWorkbenchChange !== undefined ? { onWorkbenchChange } : {})}
          {...(currentUser !== undefined ? { currentUser } : {})}
          {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
          {...(settingsOpen !== undefined ? { settingsOpen } : {})}
          {...(onSettingsOpenChange !== undefined
            ? { onSettingsOpenChange }
            : {})}
          {...(settingsSection !== undefined ? { settingsSection } : {})}
          {...(onSettingsSectionChange !== undefined
            ? { onSettingsSectionChange }
            : {})}
          {...(approvalActions !== undefined ? { approvalActions } : {})}
          {...(blockResponses !== undefined ? { blockResponses } : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
          {...(onOpenArtifactInLibrary !== undefined
            ? { onOpenArtifactInLibrary }
            : {})}
          {...(onFixConnection !== undefined ? { onFixConnection } : {})}
          {...(headerLeading !== undefined ? { headerLeading } : {})}
          {...(registerComposerInsert !== undefined
            ? { registerComposerInsert }
            : {})}
          {...(onOpenRoutines !== undefined ? { onOpenRoutines } : {})}
          {...(listMembers !== undefined ? { listMembers } : {})}
          {...(onCreateRoutineInSpace !== undefined
            ? { onCreateRoutineInSpace }
            : {})}
          {...(onOpenInsights !== undefined ? { onOpenInsights } : {})}
          {...(presenceMembers !== undefined ? { presenceMembers } : {})}
          {...(onWorkbenchNotFound !== undefined
            ? { onWorkbenchNotFound }
            : {})}
          {...(onBackToWorkbenchList !== undefined
            ? { onBackToWorkbenchList }
            : {})}
          {...(onSignIn !== undefined ? { onSignIn } : {})}
        />
      );
    case "empty":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="No workbench yet"
            description="Create or join a workbench before chatting."
          />
        </ChatWorkspaceFrame>
      );
    case "unauthenticated":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="Sign in to continue"
            description="Your conversations live on a workbench — sign in to open them."
          />
        </ChatWorkspaceFrame>
      );
    case "error":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't open this workbench"
            description={tenant.message}
          />
        </ChatWorkspaceFrame>
      );
    case "loading":
      return (
        <ChatWorkspaceFrame>
          <Skeleton className="query-skeleton" />
        </ChatWorkspaceFrame>
      );
  }
}
