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
import { EmptyState } from "@corbits/react-ui";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import type {
  MessageItem,
  MessageSender,
  ParticipantRecord,
  Part,
} from "./api";
import { ArtifactChip } from "./artifact-chip";
import { BlockPartView } from "./blocks/registry";
import type { ProfileSubject } from "./profile-subject";
import { profileSubjectFromParticipant } from "./profile-subject";
import { CHAT_STRINGS } from "./strings";

export type CurrentUser = {
  /**
   * The signed-in principal's id. A sender address's local part IS the
   * sending principal's id (the platform builds From as
   * `<principalId>@<tenant domain>`), so matching on the local part lets
   * hosts identify "you" without knowing the tenant's mail domain.
   */
  readonly principalId: string;
  readonly name?: string;
};

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

type SenderDisplay = {
  readonly label: string;
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
    return { label, isAgent: false, initials: initialsOf(label) };
  }

  const matched = participants.find(
    (participant) => participant.address === sender.address,
  );
  if (matched !== undefined) {
    const isAgent = isAgentAddress(matched.address);
    const label = isAgent ? `@${matched.handle}` : matched.handle;
    return { label, isAgent, initials: initialsOf(matched.handle) };
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

function SenderAvatar({ initials }: { initials: string }) {
  return (
    <span className="chat-sender-avatar" aria-hidden="true">
      {initials}
    </span>
  );
}

export function AgentBadge() {
  return (
    <span className="chat-agent-badge">{CHAT_STRINGS.agentBadgeLabel}</span>
  );
}

function TextBubble({
  text,
  createdAt,
  sender,
  participants,
  currentUser,
  onOpenProfile,
}: {
  text: string;
  createdAt: string;
  sender: MessageSender | undefined;
  participants: readonly ParticipantRecord[];
  currentUser: CurrentUser | undefined;
  onOpenProfile?: (subject: ProfileSubject) => void;
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
    <div className="chat-bubble-row" data-own={isOwn}>
      {display !== undefined && (
        <button
          type="button"
          className="chat-sender-avatar-button"
          aria-label={`${CHAT_STRINGS.profileOpenAction}: ${display.label}`}
          disabled={profileSubject === null || onOpenProfile === undefined}
          onClick={handleOpenProfile}
        >
          <SenderAvatar initials={display.initials} />
        </button>
      )}
      <div className="chat-bubble" data-own={isOwn}>
        <div className="chat-bubble-head">
          {display !== undefined && (
            <button
              type="button"
              className="chat-bubble-sender-button"
              disabled={profileSubject === null || onOpenProfile === undefined}
              onClick={handleOpenProfile}
            >
              <span className="chat-bubble-sender">
                {display.label}
                {display.isAgent && <AgentBadge />}
              </span>
            </button>
          )}
          <span className="chat-bubble-time">{formatTimestamp(createdAt)}</span>
        </div>
        <p className="chat-bubble-text">{text}</p>
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
        ? CHAT_STRINGS.eventAgentJoined(handle)
        : CHAT_STRINGS.eventAgentJoinedUnknown;
    case "channel.membership-changed":
      return CHAT_STRINGS.eventMembershipChanged;
    case "channel.settings-changed":
      return CHAT_STRINGS.eventSettingsChanged;
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
}: {
  part: Part & { kind: "file" };
  onOpenArtifact?: (part: Part & { kind: "file" }) => void;
}) {
  return (
    <ArtifactChip
      part={part}
      {...(onOpenArtifact !== undefined ? { onOpen: onOpenArtifact } : {})}
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

function MessageParts({
  item,
  participants,
  currentUser,
  showDayDivider,
  threadMeta,
  onOpenThread,
  onOpenProfile,
  onOpenArtifact,
}: {
  readonly item: MessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly showDayDivider: boolean;
  readonly threadMeta?: ThreadAffordanceMeta | undefined;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
}) {
  return (
    <>
      {showDayDivider && <DayDivider createdAt={item.createdAt} />}
      {item.parts.map((part, index) => {
        const key = `${item.id}-${index}`;
        if (part.kind === "text") {
          return (
            <TextBubble
              key={key}
              text={part.text}
              createdAt={item.createdAt}
              sender={item.sender}
              participants={participants}
              currentUser={currentUser}
              {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
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
            />
          );
        }
        if (part.kind === "block") {
          return <BlockPartView key={key} block={part.block} />;
        }
        return <FallbackPart key={key} part={part} />;
      })}
      {onOpenThread !== undefined ? (
        <ThreadAffordance
          messageId={item.id}
          meta={threadMeta}
          participants={participants}
          onOpen={() => onOpenThread(item.id)}
        />
      ) : null}
    </>
  );
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
  participants,
  onOpen,
}: {
  readonly messageId: string;
  readonly meta: ThreadAffordanceMeta | undefined;
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
      ? "Reply in thread"
      : replyCount === 1
        ? "1 reply"
        : `${replyCount} replies`;

  return (
    <div className="chat-thread-affordance" data-message-id={messageId}>
      {initials.length > 0 ? (
        <span className="chat-thread-avatar-stack" aria-hidden="true">
          {initials.map((value, index) => (
            <span key={`${value}-${index}`} className="chat-sender-avatar">
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
        Open
      </button>
    </div>
  );
}

export function ChannelTimeline({
  items,
  participants = [],
  currentUser,
  threadMetaByMessageId,
  onOpenThread,
  onOpenProfile,
  onOpenArtifact,
}: {
  readonly items: readonly MessageItem[];
  readonly participants?: readonly ParticipantRecord[];
  readonly currentUser?: CurrentUser;
  /** Reply-thread summary keyed by parent message id. */
  readonly threadMetaByMessageId?: ReadonlyMap<string, ThreadAffordanceMeta>;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Open a message's artifact chip — the host resolves where that goes
   * (Library today; canvas is a follow-up). No chat-ui component owns
   * routing, mirroring `onOpenThread` and `onOpenProfile`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Starts true so a channel's first render always lands pinned to the
  // bottom; afterward it tracks whether the reader is near the bottom so a
  // background message doesn't yank them away from history they're reading.
  const pinnedRef = useRef(true);

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

  if (items.length === 0) {
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
        return (
          <MessageParts
            key={item.id}
            item={item}
            participants={participants}
            currentUser={currentUser}
            showDayDivider={showDayDivider}
            threadMeta={threadMetaByMessageId?.get(item.id)}
            {...(onOpenThread !== undefined ? { onOpenThread } : {})}
            {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
            {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
          />
        );
      })}
    </div>
  );
}
