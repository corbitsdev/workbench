// Live updates for a channel: subscribe over SSE, reconnecting with backoff
// on drop, and fall back to polling `onPoll` on an interval once SSE has
// failed to establish a connection more times than `maxAttempts`. `onEvent`
// fires for every SSE message the platform's stream emits (chat.settings,
// chat.typing, and the platform's own run events); the caller decides what
// to do with each — this hook only owns the transport.

import { useEffect, useRef, useState } from "react";

export type ChannelStreamState = "connecting" | "live" | "polling";

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000];
const MAX_SSE_ATTEMPTS = BACKOFF_STEPS_MS.length;
const POLL_INTERVAL_MS = 5000;

export function useChannelStream(
  url: string,
  onEvent: (eventType: string, data: unknown) => void,
  onPoll: () => void,
): ChannelStreamState {
  const [state, setState] = useState<ChannelStreamState>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const startPolling = () => {
      if (cancelled || pollTimer !== undefined) return;
      setState("polling");
      onPollRef.current();
      pollTimer = setInterval(() => onPollRef.current(), POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (cancelled) return;
      setState((current) => (current === "polling" ? current : "connecting"));
      source = new EventSource(url);

      source.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        setState("live");
      };

      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        attempts += 1;
        if (attempts > MAX_SSE_ATTEMPTS) {
          startPolling();
          return;
        }
        const delay = BACKOFF_STEPS_MS[attempts - 1] ?? 8000;
        reconnectTimer = setTimeout(connect, delay);
      };

      const forward = (eventType: string) => (message: MessageEvent) => {
        if (cancelled) return;
        try {
          onEventRef.current(
            eventType,
            message.data === undefined ? undefined : JSON.parse(message.data),
          );
        } catch {
          onEventRef.current(eventType, message.data);
        }
      };

      for (const eventType of ["chat.settings", "chat.typing", "message"]) {
        source.addEventListener(eventType, forward(eventType));
      }
    };

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
    };
  }, [url]);

  return state;
}
