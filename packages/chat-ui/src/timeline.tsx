// Renders a channel's `MessageItem[]` oldest→newest: text parts as chat
// bubbles, event parts as inline system lines, block parts through the
// generative-UI block registry, everything else as a labeled fallback
// block. `sender` is an optional field on `MessageItem` (see
// api.ts) — a bubble never shows a raw address or instance/principal id: the
// signed-in user's own messages render as "You" (or their name, from
// `currentUser`), a sender matching a participant record renders by that
// record's mention handle (with a visible agent badge when the address is
// an agent address), and anything else falls back to a deterministic
// "Member" label with an initials avatar — never the address.

import { isAgentAddress } from "@corbits/chat/mentions";
import {
  ContextMenuView,
  contextMenuItem,
  isContextMenuEmpty,
  useContextMenuState,
} from "@corbits/context-menu";
import type { ContextMenu, ContextMenuEntry } from "@corbits/context-menu";
import { Avatar, Button, EmptyState, toast } from "@corbits/react-ui";
import {
  Clock,
  Copy,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  MessageItem,
  MessageSender,
  ParticipantRecord,
  Part,
  ReactionSummary,
} from "./api";
import { REACTION_EMOJI } from "./api";
import { ArtifactChip } from "./artifact-chip";
import type { ApprovalActions } from "./blocks/approval-actions";
import type { BlockResponseActions } from "./blocks/block-responses";
import { BlockPartView } from "./blocks/registry";
import { isClassifiedInferenceFailureText } from "./inference-failure";
import { Markdown } from "./markdown";
import type { ProfileSubject } from "./profile-subject";
import { profileSubjectFromParticipant } from "./profile-subject";
import { CHAT_STRINGS } from "./strings";

/**
 * Which affordance a message's thread row offers:
 * - `"reply"` (root feed) — open/create the depth-1 thread for this message
 * - `"fork"` (inside an open thread) — spawn a sub-thread rooted at this
 *   message, the first-class fork affordance from CL-5948 ("something
 *   Slack doesn't have"). The two-level cap is enforced server-side; this
 *   UI never needs to reason about depth itself.
 *
 * No `@corbits/context-menu` message target exists yet (see
 * `apps/web/src/shell/context-menu/targets.ts`) — this row is the
 * fallback surface for both actions until that seam is wired for
 * messages.
 */
export type ThreadAffordanceMode = "reply" | "fork";

/**
 * The reaction chip row's live round-trip — the host's toggle against
 * `@corbits/chat`'s reaction routes, mirroring how `blockResponses`
 * threads the poll/form round-trip down to its card. Undefined renders
 * no reaction affordance at all (no chips, no "add reaction" trigger),
 * the same "no port, no feature" contract every other optional action
 * on this timeline follows.
 */
export type ReactionActions = {
  readonly onToggle: (messageId: string, emoji: string) => void;
};

/** The pin/unpin round-trip a message's hover row offers — undefined
 * renders no pin affordance at all. */
export type PinActions = {
  readonly onPin: (messageId: string) => void;
  readonly onUnpin: (messageId: string) => void;
};

/** The DOM id a message's group renders under — the pinned strip's
 * jump-to-message target (`document.getElementById`). Exported so the
 * host never has to hand-guess the id format. */
export function messageDomId(messageId: string): string {
  return `chat-message-${messageId}`;
}

/**
 * `"sending"` while the host's real request is in flight, `"failed"` once
 * it has rejected. There is no `"sent"` state here — a successful send
 * simply stops being a pending item once the host's next message load
 * folds the real, server-issued message into `items` in its place.
 */
export type PendingMessageStatus = "sending" | "failed";

/**
 * A message this host has optimistically added to the timeline before
 * (or instead of, on failure) the server confirms it — see
 * `ChannelTimeline`'s `items` doc. `nonce` is the host's own client-side
 * key, round-tripped back through `PendingActions` so a retry/discard
 * always targets the exact pending entry the reader acted on, never a
 * position in an array that may have reflowed underneath it.
 */
export type TimelineMessageItem = MessageItem & {
  readonly pendingStatus?: PendingMessageStatus;
  readonly pendingNonce?: string;
  /** Set on the one synthetic item `mergeStreamingReply`
   * (`chat-workspace.tsx`) folds onto the end of the timeline while an
   * agent turn is mid-flight — its text grows as `inference.text.delta`
   * events arrive and the item disappears the moment the turn ends, see
   * `useStreamingReply` (`streaming-reply.ts`). Distinct from
   * `pendingStatus`, which is this reader's own optimistic send: a
   * streaming item is the *other* side's in-progress reply, rendered
   * without a hover toolbar, reactions, or pin toggle — none of which make
   * sense against a message with no server-issued id yet. */
  readonly streaming?: boolean;
};

/** The retry/discard round-trip a failed pending bubble's inline actions
 * offer — the host owns both: retry re-sends the same content, discard
 * drops the pending entry and hands its text back to the composer. */
export type PendingActions = {
  readonly onRetry: (nonce: string) => void;
  readonly onDiscard: (nonce: string) => void;
};

export type CurrentUser = {
  /**
   * The signed-in principal's id. A sender address's local part IS the
   * sending principal's id (the platform builds From as
   * `<principalId>@<tenant domain>`), so matching on the local part lets
   * hosts identify "you" without knowing the tenant's mail domain.
   */
  readonly principalId: string;
  readonly name?: string;
  /**
   * A handle/email fallback for the own-message avatar's initial when no
   * `name` is set — never shown as the "You" label itself, only used to
   * derive a single honest initial (see `ownAvatarInitials`) instead of
   * running `initialsOf` over the literal word "You".
   */
  readonly handle?: string;
};

/** Fallback glyph for an own-message avatar with no name and no handle to
 * derive an initial from — never a guess, never "YO" from the "You" label
 * itself. */
const UNKNOWN_INITIAL = "•";

/**
 * The signed-in reader's own avatar initials: `currentUser.name`'s real
 * initials when set, else the first letter of `currentUser.handle`
 * (a mention handle or email — whichever the host had on hand), else
 * `UNKNOWN_INITIAL`. Deliberately never derived from the "You" label
 * itself — `initialsOf("You")` reads as "YO", a fabricated pair of
 * letters with no relationship to the actual signed-in person.
 */
function ownAvatarInitials(currentUser: CurrentUser): string {
  if (currentUser.name !== undefined && currentUser.name.trim().length > 0) {
    return initialsOf(currentUser.name);
  }
  const handle = currentUser.handle?.trim();
  if (handle !== undefined && handle.length > 0) {
    return handle.charAt(0).toUpperCase();
  }
  return UNKNOWN_INITIAL;
}

export function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today" / "Yesterday" for the two nearby cases, otherwise a medium-length
 * date ("Jan 3, 2026") — never a raw ISO string.
 */
function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const now = new Date();
  if (isSameCalendarDay(date, now)) return CHAT_STRINGS.dayDividerToday;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday))
    return CHAT_STRINGS.dayDividerYesterday;

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Two-letter initials for an avatar, derived only from a friendly string
 * already safe to show (a name, a handle, or one of the fallback labels)
 * — never from a raw address or id.
 */
function initialsOf(source: string): string {
  const words = source
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const first = words[0]?.charAt(0) ?? "";
  const second =
    words.length > 1
      ? (words[1]?.charAt(0) ?? "")
      : (words[0]?.charAt(1) ?? "");
  const initials = `${first}${second}`.toUpperCase();
  return initials.length > 0 ? initials : "?";
}

/**
 * A friendly display name from a mention handle — "myra" -> "Myra",
 * "echo-bot" -> "Echo Bot" — for the rare spots (like the join event
 * line) that only have a participant's slugified handle to work with,
 * never a `sender.name`. Never applied to a handle already shown as a
 * literal `@mention` elsewhere.
 */
export function displayNameFromHandle(handle: string): string {
  return handle
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

type SenderDisplay = {
  readonly label: string;
  /** The participant's mention handle, when it differs from `label` — a
   * matched participant's `sender.name` (e.g. "Myra") is what the header
   * shows now, with the handle (e.g. "myra") surfaced only as a tooltip
   * rather than lost outright. */
  readonly handle?: string;
  readonly isAgent: boolean;
  readonly initials: string;
};

function senderDisplay(
  sender: MessageSender | undefined,
  participants: readonly ParticipantRecord[],
  currentUser: CurrentUser | undefined,
): SenderDisplay | undefined {
  if (sender === undefined) return undefined;

  if (
    currentUser !== undefined &&
    localPartOf(sender.address) === currentUser.principalId
  ) {
    const label = currentUser.name ?? CHAT_STRINGS.senderYou;
    return { label, isAgent: false, initials: ownAvatarInitials(currentUser) };
  }

  const matched = participants.find(
    (participant) => participant.address === sender.address,
  );
  if (matched !== undefined) {
    const isAgent = isAgentAddress(matched.address);
    const senderName = sender.name;
    const displayName =
      senderName !== null && senderName.trim().length > 0
        ? senderName
        : undefined;
    // An agent whose wire message carries no display name still gets a
    // human one derived from its handle ("myra" -> "Myra") — the raw
    // @handle is a wire identifier, kept to the tooltip only.
    const label =
      displayName ??
      (isAgent ? displayNameFromHandle(matched.handle) : matched.handle);
    return {
      label,
      handle: matched.handle,
      isAgent,
      initials: initialsOf(displayName ?? matched.handle),
    };
  }

  if (sender.name !== null && sender.name.trim().length > 0) {
    return {
      label: sender.name,
      isAgent: false,
      initials: initialsOf(sender.name),
    };
  }

  return {
    label: CHAT_STRINGS.senderFallbackMember,
    isAgent: false,
    initials: "?",
  };
}

/** The message header's avatar chip — the same react-ui `Avatar` (tone by
 * agent-vs-neutral, a tooltip carrying the full name) `chat-workspace.tsx`'s
 * member stack already uses, rather than a bespoke initials box. */
function SenderAvatar({
  initials,
  label,
  isAgent,
  tenantMonogram,
  tenantName,
}: {
  initials: string;
  label: string;
  isAgent: boolean;
  tenantMonogram?: string;
  tenantName?: string;
}) {
  return (
    <span className="chat-sender-avatar-wrap" title={label}>
      <Avatar
        initials={initials}
        label={label}
        tone={isAgent ? "agent" : "neutral"}
        size="md"
        className="chat-sender-avatar"
      />
      {tenantMonogram !== undefined ? (
        <span
          className="chat-sender-tenant-badge"
          title={tenantName}
          aria-hidden="true"
        >
          {tenantMonogram}
        </span>
      ) : null}
    </span>
  );
}

export function AgentBadge() {
  return (
    <span className="chat-agent-badge">{CHAT_STRINGS.agentBadgeLabel}</span>
  );
}

/** The one visible cue a message this reader just sent is still in
 * flight — reuses the muted-foreground token every other quiet status
 * glyph in this file already sits on, never a bespoke color. */
function PendingGlyph() {
  return (
    <span
      className="chat-pending-glyph"
      aria-label={CHAT_STRINGS.pendingSendLabel}
      title={CHAT_STRINGS.pendingSendLabel}
    >
      <Clock aria-hidden="true" />
    </span>
  );
}

function TextBubble({
  text,
  createdAt,
  sender,
  participants,
  currentUser,
  onOpenProfile,
  onFixConnection,
  showHeader = true,
  pendingStatus,
  pendingNonce,
  pendingActions,
}: {
  text: string;
  createdAt: string;
  sender: MessageSender | undefined;
  participants: readonly ParticipantRecord[];
  currentUser: CurrentUser | undefined;
  onOpenProfile?: (subject: ProfileSubject) => void;
  onFixConnection?: () => void;
  /** `false` when this bubble continues an unbroken run of messages from
   * the same author (see `isGroupedWithPrevious`) — the avatar and
   * name/timestamp header collapse to a hover-revealed timestamp in the
   * avatar gutter instead, matching the compact grouped-message pattern
   * modern chat UIs use rather than repeating the header on every line. */
  showHeader?: boolean;
  /** Set while this reader's own send is still in flight or has failed
   * (CL-6251/CL-5879) — the bubble renders exactly like any confirmed
   * message; `"sending"` only adds `PendingGlyph` next to the timestamp,
   * `"failed"` appends `PendingFailedRow` inside this same bubble, never
   * a different layout. */
  pendingStatus?: PendingMessageStatus;
  /** The failed bubble's own retry/discard target — see `PendingActions`.
   * Only read when `pendingStatus === "failed"`. */
  pendingNonce?: string;
  pendingActions?: PendingActions;
}) {
  const display = senderDisplay(sender, participants, currentUser);
  const isOwn =
    currentUser !== undefined &&
    sender !== undefined &&
    localPartOf(sender.address) === currentUser.principalId;
  const matched =
    sender === undefined
      ? undefined
      : participants.find(
          (participant) => participant.address === sender.address,
        );
  const profileSubject =
    matched !== undefined ? profileSubjectFromParticipant(matched) : null;

  function handleOpenProfile() {
    if (profileSubject !== null && onOpenProfile !== undefined) {
      onOpenProfile(profileSubject);
    }
  }

  return (
    <div
      className="chat-bubble-row"
      data-own={isOwn}
      data-grouped={!showHeader}
    >
      {showHeader && display !== undefined && (
        <button
          type="button"
          className="chat-sender-avatar-button"
          aria-label={`${CHAT_STRINGS.profileOpenAction}: ${display.label}`}
          disabled={profileSubject === null || onOpenProfile === undefined}
          onClick={handleOpenProfile}
        >
          <SenderAvatar
            initials={display.initials}
            label={display.label}
            isAgent={display.isAgent}
            {...(sender?.tenantMonogram !== undefined
              ? { tenantMonogram: sender.tenantMonogram }
              : {})}
            {...(sender?.tenantName !== undefined
              ? { tenantName: sender.tenantName }
              : {})}
          />
        </button>
      )}
      <div className="chat-bubble" data-own={isOwn} data-pending={pendingStatus}>
        {showHeader ? (
          <div className="chat-bubble-head">
            {display !== undefined && (
              <button
                type="button"
                className="chat-bubble-sender-button"
                disabled={
                  profileSubject === null || onOpenProfile === undefined
                }
                onClick={handleOpenProfile}
              >
                <span
                  className="chat-bubble-sender"
                  {...(display.handle !== undefined &&
                  display.handle !== display.label
                    ? { title: `@${display.handle}` }
                    : {})}
                >
                  {display.label}
                  {display.isAgent && <AgentBadge />}
                </span>
              </button>
            )}
            <span className="chat-bubble-time">
              {formatTimestamp(createdAt)}
            </span>
            {pendingStatus === "sending" ? <PendingGlyph /> : null}
          </div>
        ) : (
          <>
            <span className="chat-bubble-time-grouped">
              {formatTimestamp(createdAt)}
            </span>
            {pendingStatus === "sending" ? <PendingGlyph /> : null}
          </>
        )}
        <div className="chat-bubble-text">
          <Markdown text={text} />
        </div>
        {onFixConnection !== undefined &&
          isClassifiedInferenceFailureText(text) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="chat-bubble-fix-connection"
              onClick={onFixConnection}
            >
              {CHAT_STRINGS.fixConnectionAction}
            </Button>
          )}
        {pendingStatus === "failed" && pendingActions !== undefined ? (
          <PendingFailedRow
            nonce={pendingNonce ?? ""}
            pendingActions={pendingActions}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A friendly system line for an event part — never the raw event string on
 * its own and never any address or id out of `part.data`. Known event kinds
 * get a specific line (looking up the matching participant's handle for
 * "channel.agent-joined" rather than showing the joined agent's address);
 * anything else falls back to the event name with its separators turned
 * into spaces.
 */
function friendlyEventText(
  part: Part & { kind: "event" },
  participants: readonly ParticipantRecord[],
): string {
  const data =
    typeof part.data === "object" && part.data !== null
      ? (part.data as Record<string, unknown>)
      : undefined;
  const address =
    data !== undefined && typeof data.address === "string"
      ? data.address
      : undefined;
  const handle =
    address !== undefined
      ? participants.find((participant) => participant.address === address)
          ?.handle
      : undefined;

  switch (part.event) {
    case "channel.agent-joined":
      return handle !== undefined
        ? CHAT_STRINGS.eventAgentJoined(displayNameFromHandle(handle))
        : CHAT_STRINGS.eventAgentJoinedUnknown;
    case "channel.membership-changed":
      return CHAT_STRINGS.eventMembershipChanged;
    case "channel.settings-changed": {
      const changed =
        data !== undefined &&
        typeof data.changed === "object" &&
        data.changed !== null
          ? (data.changed as Record<string, unknown>)
          : undefined;
      const previous =
        data !== undefined &&
        typeof data.previous === "object" &&
        data.previous !== null
          ? (data.previous as Record<string, unknown>)
          : undefined;
      const to = changed?.["chat/name"];
      if (
        changed !== undefined &&
        Object.keys(changed).length === 1 &&
        typeof to === "string"
      ) {
        const from = previous?.["chat/name"];
        return typeof from === "string" && from !== to
          ? CHAT_STRINGS.eventChannelRenamed(from, to)
          : CHAT_STRINGS.eventChannelRenamedTo(to);
      }
      return CHAT_STRINGS.eventSettingsChanged;
    }
    case "chat.reply-timed-out":
      return CHAT_STRINGS.replyTimedOutNotice;
    case "block.response": {
      const kind = data !== undefined ? data.kind : undefined;
      return kind === "poll"
        ? CHAT_STRINGS.eventBlockResponsePoll
        : CHAT_STRINGS.eventBlockResponseForm;
    }
    default:
      return CHAT_STRINGS.eventGeneric(part.event);
  }
}

function EventLine({
  part,
  createdAt,
  participants,
}: {
  part: Part & { kind: "event" };
  createdAt: string;
  participants: readonly ParticipantRecord[];
}) {
  return (
    <div className="chat-event-line">
      <span>{friendlyEventText(part, participants)}</span>
      <span className="chat-event-time">{formatTimestamp(createdAt)}</span>
    </div>
  );
}

function FallbackPart({ part }: { part: Part }) {
  return (
    <div className="chat-fallback-block">
      <span className="chat-fallback-label">
        {CHAT_STRINGS.fallbackPartLabel(part.kind)}
      </span>
      <span className="chat-fallback-body">
        {CHAT_STRINGS.fallbackPartUnsupported}
      </span>
    </div>
  );
}

/**
 * A file part shows only its name and media type — never the base64 payload
 * or blob id, which are transport details rather than something a reader
 * should see in the timeline. Rendered as the mock's artifact chip; see
 * `artifact-chip.tsx` for when it opens versus stays inert.
 */
function FilePartView({
  part,
  onOpenArtifact,
  onOpenArtifactInLibrary,
}: {
  part: Part & { kind: "file" };
  onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
}) {
  return (
    <ArtifactChip
      part={part}
      {...(onOpenArtifact !== undefined ? { onOpen: onOpenArtifact } : {})}
      {...(onOpenArtifactInLibrary !== undefined
        ? { onOpenInLibrary: onOpenArtifactInLibrary }
        : {})}
    />
  );
}

function DayDivider({ createdAt }: { createdAt: string }) {
  return (
    <div className="chat-day-divider">
      <span>{formatDayLabel(createdAt)}</span>
    </div>
  );
}

/**
 * The reaction chip row: every emoji with at least one reactor renders as a
 * chip (count + reacted-state). Renders nothing when there are no reactions
 * — the "add a reaction" affordance itself lives in `MessageHoverToolbar`
 * now, not here, so a message with zero reactions shows no chip row at all
 * until hovered.
 */
function ReactionChips({
  messageId,
  reactions,
  reactionActions,
}: {
  readonly messageId: string;
  readonly reactions: readonly ReactionSummary[];
  readonly reactionActions: ReactionActions;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="chat-reaction-row">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className="chat-reaction-chip"
          data-reacted={reaction.reactedByMe}
          aria-pressed={reaction.reactedByMe}
          aria-label={CHAT_STRINGS.reactionChipLabel(
            reaction.emoji,
            reaction.count,
          )}
          onClick={() => reactionActions.onToggle(messageId, reaction.emoji)}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="chat-reaction-chip-count">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}

async function copyMessageText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(CHAT_STRINGS.copyTextCopiedToast);
  } catch {
    toast(CHAT_STRINGS.copyTextError);
  }
}

function messageText(item: MessageItem): string {
  return item.parts
    .filter((part): part is Part & { kind: "text" } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * A failed send's inline recovery row (CL-6251/CL-5879): appended below
 * the bubble text of the exact same message group a confirmed message
 * would render as — never a status line elsewhere on the page,
 * disconnected from the message it describes.
 */
function PendingFailedRow({
  nonce,
  pendingActions,
}: {
  readonly nonce: string;
  readonly pendingActions: PendingActions;
}) {
  return (
    <div className="chat-pending-failed-row" role="alert">
      <span className="chat-pending-failed-label">
        {CHAT_STRINGS.pendingSendFailedLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="chat-pending-retry"
        onClick={() => pendingActions.onRetry(nonce)}
      >
        {CHAT_STRINGS.pendingSendRetryAction}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="chat-pending-discard"
        onClick={() => pendingActions.onDiscard(nonce)}
      >
        {CHAT_STRINGS.pendingSendDiscardAction}
      </Button>
    </div>
  );
}

/**
 * The in-progress agent reply's bubble: same header (avatar, name, agent
 * badge) a finished agent message would show — `item.sender` is the agent
 * participant `mergeStreamingReply` resolved it against, exactly as
 * `senderDisplay` matches any other message's sender — but no hover
 * toolbar, reactions, pin toggle, or thread affordance, since none of
 * those round-trips make sense against a message the server hasn't
 * persisted (or issued an id for) yet. The blinking `chat-block-cursor`
 * after the text is the one visible cue this bubble is still growing.
 */
function StreamingMessageGroup({
  item,
  participants,
  currentUser,
  showDayDivider,
}: {
  readonly item: TimelineMessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly showDayDivider: boolean;
}) {
  const text = messageText(item);
  const display = senderDisplay(item.sender, participants, currentUser);

  return (
    <div className="chat-message-group" id={messageDomId(item.id)}>
      {showDayDivider && <DayDivider createdAt={item.createdAt} />}
      <div className="chat-bubble-row" data-own="false">
        {display !== undefined && (
          <SenderAvatar
            initials={display.initials}
            label={display.label}
            isAgent={display.isAgent}
          />
        )}
        <div className="chat-bubble" data-own="false">
          {display !== undefined && (
            <div className="chat-bubble-head">
              <span className="chat-bubble-sender">
                {display.label}
                {display.isAgent && <AgentBadge />}
              </span>
            </div>
          )}
          <p className="chat-bubble-text">
            {text}
            <span className="chat-block-cursor" aria-hidden="true" />
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The ellipsis/right-click menu for a message: everything that used to be
 * a persistent inline affordance (reply-in-thread) plus copy and pin, all
 * in one place so the two triggers (the hover toolbar's ellipsis button and
 * a right-click anywhere on the message) always offer the same actions.
 */
function buildMessageMenu({
  item,
  threadAffordanceMode,
  onOpenThread,
  pinActions,
}: {
  readonly item: MessageItem;
  readonly threadAffordanceMode: ThreadAffordanceMode;
  readonly onOpenThread: ((messageId: string) => void) | undefined;
  readonly pinActions: PinActions | undefined;
}): ContextMenu {
  const entries: ContextMenuEntry[] = [];

  if (onOpenThread !== undefined) {
    entries.push(
      contextMenuItem({
        id: "reply-in-thread",
        label:
          threadAffordanceMode === "fork"
            ? CHAT_STRINGS.forkThreadAction
            : CHAT_STRINGS.replyInThreadAction,
        icon: <Reply aria-hidden="true" />,
        onSelect: () => onOpenThread(item.id),
      }),
    );
  }

  const text = messageText(item);
  if (text.length > 0) {
    entries.push(
      contextMenuItem({
        id: "copy-text",
        label: CHAT_STRINGS.copyTextAction,
        icon: <Copy aria-hidden="true" />,
        onSelect: () => {
          void copyMessageText(text);
        },
      }),
    );
  }

  if (pinActions !== undefined) {
    const pinned = item.pinned ?? false;
    entries.push(
      contextMenuItem({
        id: "toggle-pin",
        label: pinned
          ? CHAT_STRINGS.unpinMessageAction
          : CHAT_STRINGS.pinMessageAction,
        icon: pinned ? (
          <PinOff aria-hidden="true" />
        ) : (
          <Pin aria-hidden="true" />
        ),
        onSelect: () =>
          pinned ? pinActions.onUnpin(item.id) : pinActions.onPin(item.id),
      }),
    );
  }

  return { entries };
}

/**
 * The compact trailing-edge action cluster a message reveals on hover or
 * keyboard focus-within — add-reaction, reply-in-thread, and the ellipsis
 * menu (see `buildMessageMenu`). Nothing here renders permanently; a quiet
 * conversation shows plain text until a reader hovers a line, matching the
 * reference pattern this replaces (a persistent inline "Reply in thread"
 * link under every message).
 */
function MessageHoverToolbar({
  messageId,
  menu,
  menuOpen,
  onOpenMenu,
  threadAffordanceMode,
  onOpenThread,
  reactionActions,
}: {
  readonly messageId: string;
  readonly menu: ContextMenu;
  readonly menuOpen: boolean;
  readonly onOpenMenu: (x: number, y: number, origin: Element) => void;
  readonly threadAffordanceMode: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly reactionActions?: ReactionActions;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLSpanElement>(null);

  // A click/tap anywhere outside the picker closes it, same as Escape —
  // without this, the picker is the one popover on this surface that only
  // ever closes on a second click of its own trigger or a selection.
  useEffect(() => {
    if (!pickerOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const anchor = pickerAnchorRef.current;
      if (anchor === null) return;
      if (event.target instanceof Node && anchor.contains(event.target)) {
        return;
      }
      setPickerOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pickerOpen]);

  function toggleReaction(emoji: string) {
    reactionActions?.onToggle(messageId, emoji);
    setPickerOpen(false);
  }

  const menuHasEntries = !isContextMenuEmpty(menu);
  if (
    reactionActions === undefined &&
    onOpenThread === undefined &&
    !menuHasEntries
  ) {
    return null;
  }

  return (
    <div
      className="chat-hover-toolbar"
      data-thread-affordance-mode={threadAffordanceMode}
      data-open={pickerOpen || menuOpen}
    >
      {reactionActions !== undefined ? (
        <span className="chat-reaction-picker-anchor" ref={pickerAnchorRef}>
          <button
            type="button"
            className="chat-reaction-add"
            aria-label={CHAT_STRINGS.reactionAddAction}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <SmilePlus aria-hidden="true" />
          </button>
          {pickerOpen ? (
            <span
              className="chat-reaction-picker"
              role="menu"
              aria-label={CHAT_STRINGS.reactionPickerLabel}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPickerOpen(false);
              }}
            >
              {REACTION_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className="chat-reaction-picker-option"
                  aria-label={CHAT_STRINGS.reactionPickerOptionLabel(emoji)}
                  onClick={() => toggleReaction(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {onOpenThread !== undefined ? (
        <button
          type="button"
          className="chat-hover-reply"
          aria-label={
            threadAffordanceMode === "fork"
              ? CHAT_STRINGS.forkThreadAction
              : CHAT_STRINGS.replyInThreadAction
          }
          onClick={() => onOpenThread(messageId)}
        >
          <Reply aria-hidden="true" />
        </button>
      ) : null}
      {menuHasEntries ? (
        <button
          type="button"
          className="chat-hover-ellipsis"
          aria-label={CHAT_STRINGS.messageActionsMenuLabel}
          aria-expanded={menuOpen}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom, event.currentTarget);
          }}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** The pin/unpin toggle a message's hover row offers — renders nothing
 * when `pinActions` is undefined. */
function PinToggleButton({
  messageId,
  pinned,
  pinActions,
}: {
  readonly messageId: string;
  readonly pinned: boolean;
  readonly pinActions: PinActions;
}) {
  return (
    <button
      type="button"
      className="chat-pin-toggle"
      data-pinned={pinned}
      aria-pressed={pinned}
      aria-label={
        pinned ? CHAT_STRINGS.unpinMessageAction : CHAT_STRINGS.pinMessageAction
      }
      onClick={() =>
        pinned ? pinActions.onUnpin(messageId) : pinActions.onPin(messageId)
      }
    >
      {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
    </button>
  );
}

function MessageParts({
  item,
  participants,
  currentUser,
  showDayDivider,
  showHeader,
  threadMeta,
  threadAffordanceMode = "reply",
  onOpenThread,
  onOpenProfile,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  reactionActions,
  pinActions,
  pendingActions,
}: {
  readonly item: TimelineMessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly showDayDivider: boolean;
  /** `false` when this message continues an unbroken run from the same
   * author as the item directly above it — see `isGroupedWithPrevious`. */
  readonly showHeader: boolean;
  readonly threadMeta?: ThreadAffordanceMeta | undefined;
  readonly threadAffordanceMode?: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's quiet "Fix this
   * connection" action (CL-6092) — undefined renders no affordance at
   * all, the same "no port, no feature" contract every other optional
   * action here follows. No chat-ui component owns routing: the host
   * decides where "fix" goes (Plugins' connect panel today). */
  readonly onFixConnection?: () => void;
  readonly approvalActions?: ApprovalActions;
  readonly blockResponses?: BlockResponseActions;
  readonly reactionActions?: ReactionActions;
  readonly pinActions?: PinActions;
  /** This reader's own failed send's inline Retry/Discard — see
   * `PendingActions`. Undefined on every ordinary message; on a failed
   * pending item (`item.pendingStatus === "failed"`) with no actions
   * wired, the failed row simply doesn't render. */
  readonly pendingActions?: PendingActions;
}) {
  // A message this reader's own composer submitted and the server hasn't
  // issued an id for yet (see `TimelineMessageItem.pendingStatus`) offers
  // none of the round-trips below — reactions, pin, thread, context menu —
  // since every one of them targets a server-issued message id that
  // doesn't exist yet for this item.
  const isPending = item.pendingStatus !== undefined;
  const contextMenu = useContextMenuState();
  const menu = isPending
    ? { entries: [] }
    : buildMessageMenu({
        item,
        threadAffordanceMode,
        onOpenThread,
        pinActions,
      });
  const replyCount = threadMeta?.replyCount ?? 0;
  const pendingNonce = item.pendingNonce ?? item.id;
  // Same identity `ChannelTimeline`'s render loop keys this whole group
  // under (`clientId` when the wire echoed one, else `id`) — reused here
  // for each part's own key so a pending send's `TextBubble` (and its
  // avatar) is the very DOM node its later confirmed copy updates in
  // place, never a remount keyed off the pending nonce vs. the eventual
  // server-issued id.
  const groupKey = item.clientId ?? item.id;

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (isPending || isContextMenuEmpty(menu)) return;
    event.preventDefault();
    contextMenu.show(event.clientX, event.clientY, menu, event.currentTarget);
  }

  return (
    <div
      className="chat-message-group"
      id={messageDomId(item.id)}
      data-grouped={!showHeader}
      data-pending={item.pendingStatus}
      onContextMenu={handleContextMenu}
    >
      {showDayDivider && <DayDivider createdAt={item.createdAt} />}
      {item.parts.map((part, index) => {
        const key = `${groupKey}-${index}`;
        if (part.kind === "text") {
          return (
            <TextBubble
              key={key}
              text={part.text}
              createdAt={item.createdAt}
              sender={item.sender}
              participants={participants}
              currentUser={currentUser}
              showHeader={showHeader}
              {...(item.pendingStatus !== undefined
                ? { pendingStatus: item.pendingStatus, pendingNonce }
                : {})}
              {...(pendingActions !== undefined ? { pendingActions } : {})}
              {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
              {...(onFixConnection !== undefined ? { onFixConnection } : {})}
            />
          );
        }
        if (part.kind === "event") {
          return (
            <EventLine
              key={key}
              part={part}
              createdAt={item.createdAt}
              participants={participants}
            />
          );
        }
        if (part.kind === "file") {
          return (
            <FilePartView
              key={key}
              part={part}
              {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
              {...(onOpenArtifactInLibrary !== undefined
                ? { onOpenArtifactInLibrary }
                : {})}
            />
          );
        }
        if (part.kind === "block") {
          return (
            <BlockPartView
              key={key}
              block={part.block}
              messageId={item.id}
              {...(approvalActions !== undefined ? { approvalActions } : {})}
              {...(blockResponses !== undefined ? { blockResponses } : {})}
            />
          );
        }
        return <FallbackPart key={key} part={part} />;
      })}
      {!isPending &&
      ((reactionActions !== undefined && (item.reactions?.length ?? 0) > 0) ||
        pinActions !== undefined) ? (
        <div className="chat-message-actions">
          {reactionActions !== undefined ? (
            <ReactionChips
              messageId={item.id}
              reactions={item.reactions ?? []}
              reactionActions={reactionActions}
            />
          ) : null}
          {pinActions !== undefined ? (
            <PinToggleButton
              messageId={item.id}
              pinned={item.pinned ?? false}
              pinActions={pinActions}
            />
          ) : null}
        </div>
      ) : null}
      {!isPending && onOpenThread !== undefined && replyCount > 0 ? (
        <ThreadAffordance
          messageId={item.id}
          meta={threadMeta}
          mode={threadAffordanceMode}
          participants={participants}
          onOpen={() => onOpenThread(item.id)}
        />
      ) : null}
      {!isPending ? (
        <MessageHoverToolbar
          messageId={item.id}
          menu={menu}
          menuOpen={contextMenu.open}
          onOpenMenu={(x, y, origin) => contextMenu.show(x, y, menu, origin)}
          threadAffordanceMode={threadAffordanceMode}
          {...(onOpenThread !== undefined ? { onOpenThread } : {})}
          {...(reactionActions !== undefined ? { reactionActions } : {})}
        />
      ) : null}
      <ContextMenuView
        x={contextMenu.x}
        y={contextMenu.y}
        menu={contextMenu.menu}
        open={contextMenu.open}
        restoreFocusTo={contextMenu.triggerElement}
        onOpenChange={(next) => {
          if (!next) contextMenu.hide();
        }}
      />
    </div>
  );
}

/**
 * Whether `item`'s header (avatar + name + timestamp) collapses because it
 * continues an unbroken run of text messages from the same author as
 * `previous` — the compact grouped-message pattern modern chat UIs use so a
 * quick back-to-back exchange doesn't repeat the same name and avatar on
 * every line. Never groups across a day divider or a message that isn't
 * itself a plain text bubble (an event line or a fallback block always
 * gets its own header on the next real bubble). A pending (optimistic)
 * send groups exactly like any confirmed message from the same author —
 * CL-5879 renders it through this same path, not a separate tier.
 */
function isGroupedWithPrevious(
  item: TimelineMessageItem,
  previous: TimelineMessageItem | undefined,
  showDayDivider: boolean,
): boolean {
  if (showDayDivider || previous === undefined) return false;
  const isTextOnly = (target: TimelineMessageItem) =>
    target.parts.every((part) => part.kind === "text") &&
    target.parts.some((part) => part.kind === "text");
  if (!isTextOnly(item) || !isTextOnly(previous)) return false;
  const address = item.sender?.address;
  return address !== undefined && address === previous.sender?.address;
}

export type ThreadAffordanceMeta = {
  readonly replyCount: number;
  readonly lastActivityAt: string | null;
  readonly participantAddresses: readonly string[];
};

function formatRelativeActivity(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ThreadAffordance({
  messageId,
  meta,
  mode,
  participants,
  onOpen,
}: {
  readonly messageId: string;
  readonly meta: ThreadAffordanceMeta | undefined;
  readonly mode: ThreadAffordanceMode;
  readonly participants: readonly ParticipantRecord[];
  readonly onOpen: () => void;
}) {
  const replyCount = meta?.replyCount ?? 0;
  const addresses = meta?.participantAddresses ?? [];
  const initials = addresses.slice(0, 3).map((address) => {
    const handle =
      participants.find((p) => p.address === address)?.handle ??
      address.slice(0, 1);
    return initialsOf(handle);
  });
  const activity = formatRelativeActivity(meta?.lastActivityAt ?? null);
  const label =
    replyCount === 0
      ? mode === "fork"
        ? CHAT_STRINGS.forkThreadAction
        : "Reply in thread"
      : replyCount === 1
        ? "1 reply"
        : `${replyCount} replies`;

  return (
    <div
      className="chat-thread-affordance"
      data-message-id={messageId}
      data-thread-affordance-mode={mode}
    >
      {initials.length > 0 ? (
        <span className="chat-thread-avatar-stack" aria-hidden="true">
          {initials.map((value, index) => (
            <span key={`${value}-${index}`} className="chat-thread-avatar-chip">
              {value}
            </span>
          ))}
        </span>
      ) : null}
      <span className="chat-thread-affordance-meta">
        <span className="chat-thread-reply-count">{label}</span>
        {activity !== "" ? (
          <span className="chat-thread-last-activity">{activity}</span>
        ) : null}
      </span>
      <button type="button" className="chat-thread-open" onClick={onOpen}>
        {mode === "fork" ? CHAT_STRINGS.forkThreadAction : "Open"}
      </button>
    </div>
  );
}

/** A channel's scroll position, captured/restored across a
 * `ChannelTimeline` unmount-remount (e.g. opening/closing Settings) — see
 * `ChannelTimeline`'s `scrollRestore`/`onScrollSnapshot`. */
export type ScrollSnapshot = {
  readonly scrollTop: number;
  readonly pinned: boolean;
};

export function ChannelTimeline({
  items,
  participants = [],
  settingUpAgent,
  currentUser,
  threadMetaByMessageId,
  threadAffordanceMode = "reply",
  onOpenThread,
  onOpenProfile,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  reactionActions,
  pinActions,
  pendingActions,
  scrollRestore,
  onScrollSnapshot,
}: {
  /** Server-issued messages, oldest→newest, plus any optimistic entries
   * the host is still resolving — see `TimelineMessageItem`'s
   * `pendingStatus`. An ordinary item simply omits it. */
  readonly items: readonly TimelineMessageItem[];
  readonly participants?: readonly ParticipantRecord[];
  /** True for an agent chat still finishing its background launch —
   * renders the setting-up state instead of "No messages yet". */
  readonly settingUpAgent?: boolean;
  readonly currentUser?: CurrentUser;
  /** Reply-thread summary keyed by parent message id. */
  readonly threadMetaByMessageId?: ReadonlyMap<string, ThreadAffordanceMeta>;
  /** `"reply"` on the channel root feed, `"fork"` inside an open thread —
   * see `ThreadAffordanceMode`. */
  readonly threadAffordanceMode?: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Open a message's artifact chip — the host resolves where that goes
   * (Library today; canvas is a follow-up). No chat-ui component owns
   * routing, mirroring `onOpenThread` and `onOpenProfile`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — a second, host-supplied hop
   * alongside `onOpenArtifact`, only ever offered when the part carries an
   * `artifactId` (see `ArtifactChip`). */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's quiet "Fix this
   * connection" action (CL-6092) — see `MessageParts`' own doc. */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — the host's read/approve/reject
   * on the platform approval a card references. Undefined renders every
   * approve card in its pre-round-trip fixed-disabled framing. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — the host's read/vote/submit
   * against `@corbits/chat`'s response routes. Undefined renders every
   * poll/form card in its pre-round-trip fixed-disabled framing. */
  readonly blockResponses?: BlockResponseActions;
  /** The reaction chip row's live round-trip — see `ReactionActions`.
   * Undefined renders no chips and no "add reaction" trigger at all,
   * the same "no port, no feature" contract `blockResponses` follows. */
  readonly reactionActions?: ReactionActions;
  /** The hover pin/unpin toggle — see `PinActions`. Undefined renders
   * no pin affordance on any message. */
  readonly pinActions?: PinActions;
  /** The failed pending bubble's inline Retry/Discard — see
   * `PendingActions`. Undefined renders a failed pending item with no
   * recovery affordance at all (still shown as failed). */
  readonly pendingActions?: PendingActions;
  /** The scroll position to restore on mount — the host's own memory of
   * where this channel's reader last was, captured via `onScrollSnapshot`
   * the last time this component unmounted (e.g. opening Settings, which
   * swaps this whole component out for the settings surface). Undefined
   * mounts pinned to the bottom, same as a channel's first-ever render. */
  readonly scrollRestore?: ScrollSnapshot;
  /** Called once, from this component's unmount cleanup, with its final
   * scroll position — the host's only chance to remember it, since this
   * component owns no state itself once it's gone. */
  readonly onScrollSnapshot?: (snapshot: ScrollSnapshot) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Starts pinned (true) unless a restored snapshot says otherwise — a
  // channel's first-ever render always lands at the bottom, but remounting
  // after Settings closes restores exactly how the reader left it.
  const pinnedRef = useRef(scrollRestore?.pinned ?? true);

  // Kept current every render (never a dependency) so the unmount cleanup
  // below always calls the host's latest callback, not a stale one closed
  // over at mount time.
  const onScrollSnapshotRef = useRef(onScrollSnapshot);
  onScrollSnapshotRef.current = onScrollSnapshot;

  const BOTTOM_PIN_THRESHOLD_PX = 40;

  const handleScroll = () => {
    const container = containerRef.current;
    if (container === null) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedRef.current = distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [items.length]);

  // Restores an unpinned reader's exact offset once, on mount — the
  // items.length effect above already handles the pinned case (it fires on
  // this same mount). Deliberately empty deps: this only ever runs once, a
  // restore is a one-time act on remount, not something to repeat every
  // time `scrollRestore` happens to be a new object.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (scrollRestore !== undefined && !scrollRestore.pinned) {
      container.scrollTop = scrollRestore.scrollTop;
    }
    return () => {
      onScrollSnapshotRef.current?.({
        scrollTop: container.scrollTop,
        pinned: pinnedRef.current,
      });
    };
  }, []);

  // A sibling mounting or growing below the timeline (the turn-activity
  // strip, a typing indicator) changes the scroll container's content
  // height without changing `items.length` — the effect above never fires
  // for it, so a pinned reader would otherwise watch their own view get
  // visually shoved by chrome they never asked to track. `ResizeObserver`
  // is absent in some test environments (jsdom has no implementation), so
  // this is a no-op there rather than a crash.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  if (items.length === 0) {
    // A freshly minted agent chat answers before its launches finish
    // (async mint): the agent participant streams in seconds later. An
    // empty agent chat is therefore SETTING UP, never "say something" —
    // that copy invites racing the greeting.
    const agentJoined = participants.some((participant) =>
      isAgentAddress(participant.address),
    );
    if (settingUpAgent === true) {
      return (
        <div className="chat-timeline-empty">
          <div className="chat-workbench-loading" role="status">
            <span className="chat-workbench-loading-mark" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </span>
            <span className="chat-workbench-loading-title">
              {CHAT_STRINGS.workbenchLoadingTitle}
            </span>
            <span className="chat-workbench-loading-stage">
              {agentJoined
                ? CHAT_STRINGS.workbenchLoadingAgentJoined
                : CHAT_STRINGS.workbenchLoadingStarting}
            </span>
          </div>
        </div>
      );
    }
    return (
      <div className="chat-timeline-empty">
        <EmptyState
          icon={<MessageSquare />}
          title={CHAT_STRINGS.emptyTimelineTitle}
          description={CHAT_STRINGS.emptyTimelineDescription}
        />
      </div>
    );
  }

  return (
    <div className="chat-timeline" ref={containerRef} onScroll={handleScroll}>
      {items.map((item, index) => {
        const previous = index > 0 ? items[index - 1] : undefined;
        const showDayDivider =
          previous === undefined ||
          !isSameCalendarDay(
            new Date(previous.createdAt),
            new Date(item.createdAt),
          );
        // Keyed by `clientId` (falling back to `id`) when present: a
        // pending send and the confirmed message that later reconciles
        // it (CL-6251's wire `clientId`) share this key, so React
        // updates the same DOM node in place — avatar, header and all —
        // rather than unmounting a "sending" bubble and mounting an
        // unrelated "confirmed" one, which is what used to read as an
        // unsent→sent swap (CL-6251, reopened).
        const key = item.clientId ?? item.id;
        if (item.streaming === true) {
          return (
            <StreamingMessageGroup
              key={key}
              item={item}
              participants={participants}
              currentUser={currentUser}
              showDayDivider={showDayDivider}
            />
          );
        }
        const showHeader = !isGroupedWithPrevious(
          item,
          previous,
          showDayDivider,
        );
        return (
          <MessageParts
            key={key}
            item={item}
            participants={participants}
            currentUser={currentUser}
            showDayDivider={showDayDivider}
            showHeader={showHeader}
            threadMeta={threadMetaByMessageId?.get(item.id)}
            threadAffordanceMode={threadAffordanceMode}
            {...(onOpenThread !== undefined ? { onOpenThread } : {})}
            {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
            {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
            {...(onFixConnection !== undefined ? { onFixConnection } : {})}
            {...(onOpenArtifactInLibrary !== undefined
              ? { onOpenArtifactInLibrary }
              : {})}
            {...(approvalActions !== undefined ? { approvalActions } : {})}
            {...(blockResponses !== undefined ? { blockResponses } : {})}
            {...(reactionActions !== undefined ? { reactionActions } : {})}
            {...(pinActions !== undefined ? { pinActions } : {})}
            {...(pendingActions !== undefined ? { pendingActions } : {})}
          />
        );
      })}
    </div>
  );
}
