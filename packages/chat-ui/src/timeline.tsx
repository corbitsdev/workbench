// Renders a channel's `MessageItem[]` oldest→newest: text parts as chat
// bubbles, event parts as inline system lines, everything else as a labeled
// fallback block. `sender` is an optional field on `MessageItem` (see
// api.ts) while packages/chat rolls it out, so a bubble shows the sender's
// name — falling back to the local part of its address, then to nothing —
// alongside its timestamp.

import { EmptyState } from "@corbits/react-ui";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import type { MessageItem, MessageSender, Part } from "./api";
import { CHAT_STRINGS } from "./strings";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

function senderLabel(sender: MessageSender | undefined): string | undefined {
  if (sender === undefined) return undefined;
  return sender.name ?? localPartOf(sender.address);
}

function TextBubble({
  text,
  createdAt,
  sender,
}: {
  text: string;
  createdAt: string;
  sender: MessageSender | undefined;
}) {
  const label = senderLabel(sender);
  return (
    <div className="chat-bubble-row">
      <div className="chat-bubble">
        {label !== undefined && (
          <span className="chat-bubble-sender">{label}</span>
        )}
        <p className="chat-bubble-text">{text}</p>
        <span className="chat-bubble-time">{formatTimestamp(createdAt)}</span>
      </div>
    </div>
  );
}

function EventLine({
  part,
  createdAt,
}: {
  part: Part & { kind: "event" };
  createdAt: string;
}) {
  return (
    <div className="chat-event-line">
      <span>{part.event}</span>
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

function MessageParts({ item }: { readonly item: MessageItem }) {
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
            />
          );
        }
        if (part.kind === "event") {
          return <EventLine key={key} part={part} createdAt={item.createdAt} />;
        }
        return <FallbackPart key={key} part={part} />;
      })}
    </>
  );
}

export function ChannelTimeline({
  items,
}: {
  readonly items: readonly MessageItem[];
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
        <MessageParts key={item.id} item={item} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
