// Renders a channel's `MessageItem[]` oldest→newest: text parts as chat
// bubbles, event parts as inline system lines, everything else as a labeled
// fallback block. The API's current `/messages` response carries no sender
// field (see api.ts), so a bubble shows only its timestamp — the moment the
// route grows a sender, this is the only file that needs it.

import { EmptyState } from "@corbits/react-ui";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import type { MessageItem, Part } from "./api";
import { CHAT_STRINGS } from "./strings";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TextBubble({ text, createdAt }: { text: string; createdAt: string }) {
  return (
    <div className="chat-bubble-row">
      <div className="chat-bubble">
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
            <TextBubble key={key} text={part.text} createdAt={item.createdAt} />
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
