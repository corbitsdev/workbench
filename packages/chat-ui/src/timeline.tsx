// Renders a channel's `MessageItem[]` oldest→newest: text parts as chat
// bubbles, event parts as inline system lines, everything else as a labeled
// fallback block. `sender` is an optional field on `MessageItem` (see
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

function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

function AgentBadge() {
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
}: {
  text: string;
  createdAt: string;
  sender: MessageSender | undefined;
  participants: readonly ParticipantRecord[];
  currentUser: CurrentUser | undefined;
}) {
  const display = senderDisplay(sender, participants, currentUser);
  return (
    <div className="chat-bubble-row">
      {display !== undefined && <SenderAvatar initials={display.initials} />}
      <div className="chat-bubble">
        {display !== undefined && (
          <span className="chat-bubble-sender">
            {display.label}
            {display.isAgent && <AgentBadge />}
          </span>
        )}
        <p className="chat-bubble-text">{text}</p>
        <span className="chat-bubble-time">{formatTimestamp(createdAt)}</span>
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
      <pre className="chat-fallback-body">{JSON.stringify(part, null, 2)}</pre>
    </div>
  );
}

function MessageParts({
  item,
  participants,
  currentUser,
}: {
  readonly item: MessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
}) {
  return (
    <>
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
        return <FallbackPart key={key} part={part} />;
      })}
    </>
  );
}

export function ChannelTimeline({
  items,
  participants = [],
  currentUser,
}: {
  readonly items: readonly MessageItem[];
  readonly participants?: readonly ParticipantRecord[];
  readonly currentUser?: CurrentUser;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
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
    <div className="chat-timeline">
      {items.map((item) => (
        <MessageParts
          key={item.id}
          item={item}
          participants={participants}
          currentUser={currentUser}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
